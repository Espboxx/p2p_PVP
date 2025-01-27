import { rtcConfig, iceConfig, CONNECTION_TIMEOUT, ICE_GATHERING_TIMEOUT, ConnectionPriority } from './config.js';
import { socket, onlineUsers } from './socket.js';
import { setupDataChannel } from './dataChannel.js';
import { displayMessage, updateUIState, updateUserList } from './ui.js';
import { ConnectionState, updateConnectionState } from './connectionState.js';

export const peerConnections = new Map(); // key: socketId, value: { pc: RTCPeerConnection, dataChannel: RTCDataChannel }
let connectionTimeouts = new Map(); // 存储连接超时计时器
let reconnectAttempts = new Map(); // 记录重连次数
const connectionAttempts = new Map(); // 存储连接尝试次数

// 添加连接状态监控
let iceGatheringTimeouts = new Map();
let candidateTypes = new Map(); // 记录收集到的候选项类型

// 存储每个连接的候选项信息
const candidateInfo = new Map();

export async function createPeerConnection(targetId) {
    const userId = onlineUsers.get(targetId);
    // 检查目标用户是否在线且有效
    if (!userId) {
        console.log(`不创建与未知用户 ${targetId} 的连接`);
        return null;
    }

    try {
        // 设置初始连接状态
        updateConnectionState(targetId, ConnectionState.CONNECTING, {
            onlineUsers,
            updateUserList,
            displayMessage
        });
        
        const pc = new RTCPeerConnection(rtcConfig);
        
        const connection = { pc, dataChannel: null, currentTransfer: null };
        peerConnections.set(targetId, connection);
        
        // 设置连接超时
        const timeoutId = setTimeout(() => {
            handleConnectionTimeout(targetId);
        }, CONNECTION_TIMEOUT);
        
        connectionTimeouts.set(targetId, timeoutId);
        
        // 设置 ICE 收集超时
        const iceTimeoutId = setTimeout(() => {
            handleIceGatheringTimeout(targetId);
        }, ICE_GATHERING_TIMEOUT);
        
        iceGatheringTimeouts.set(targetId, iceTimeoutId);
        
        const dataChannel = pc.createDataChannel('chatChannel');
        setupDataChannel(dataChannel, targetId);
        connection.dataChannel = dataChannel;
        
        pc.ondatachannel = (event) => {
            const receiveChannel = event.channel;
            console.log(`收到来自 ${targetId} 的数据通道`);
            setupDataChannel(receiveChannel, targetId);
            const conn = peerConnections.get(targetId);
            if (conn) {
                conn.dataChannel = receiveChannel;
                console.log(`接收的数据通道已绑定到 ${targetId}`);
                
                // 连接成功，清除超时计时器
                clearConnectionTimeout(targetId);
            }
        };
        
        // 监控 ICE 候选项类型
        pc.onicecandidate = ({ candidate }) => {
            handleIceCandidate(pc, targetId, candidate);
        };
        pc.onnegotiationneeded = async () => {
            try {
                await pc.setLocalDescription(await pc.createOffer());
                console.log(`发送 offer 给 ${targetId}`);
                
                socket.emit('signal', {
                    to: targetId,
                    signal: { 
                        type: 'offer', 
                        offer: pc.localDescription 
                    }
                });
            } catch (err) {
                console.error('创建 offer 失败:', err);
            }
        };
      
        pc.onconnectionstatechange = () => {
            handleConnectionStateChange(pc, targetId, dataChannel);
            console.log(`Connection state changed to: ${pc.connectionState} for peer ${targetId}`);
            
            // 添加更详细的状态日志
            console.log(`ICE Connection state: ${pc.iceConnectionState}`);
            console.log(`Data channel state: ${dataChannel.readyState}`);
            
            let connectionState;
            
            // 分离连接状态检查逻辑
            if (pc.connectionState === 'connected' && dataChannel.readyState === 'open') {
                connectionState = ConnectionState.CONNECTED;
                // 连接成功时重置重连计数
                connectionAttempts.delete(targetId);
            } else if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
                connectionState = ConnectionState.CONNECTING;
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
                // 获取当前重连次数
                const attempts = (connectionAttempts.get(targetId)?.attempts || 0) + 1;
                connectionAttempts.set(targetId, { attempts });
                
                if (attempts >= 3) {
                    connectionState = ConnectionState.FAILED;
                    console.log(`连接失败，已重试 ${attempts} 次`);
                } else {
                    connectionState = ConnectionState.DISCONNECTED;
                    // 设置重连延迟，避免立即重连
                    setTimeout(() => {
                        if (onlineUsers.has(targetId)) {
                            console.log(`尝试第 ${attempts} 次重连...`);
                            handleConnectionFailure(targetId);
                        }
                    }, 1000 * attempts);
                }
            }

            // 只在状态确实发生变化时更新
            if (connectionState) {
                updateConnectionState(targetId, connectionState, {
                    onlineUsers,
                    updateUserList,
                    displayMessage
                });
                
                // 立即触发 UI 更新
                requestAnimationFrame(() => {
                    updateUIState();
                });
            }

            // 广播状态变化
            socket.emit('connection-state-change', {
                targetId,
                state: pc.connectionState,
                dataChannelState: dataChannel.readyState
            });

            // 处理连接状态
            if (pc.connectionState === 'connected') {
                clearConnectionTimeout(targetId);
                const peerName = onlineUsers.get(targetId) || '未知用户';
                displayMessage(`系统: 与 ${peerName} 的连接已建立`, 'system');
            }

            if (pc.connectionState === 'failed') {
                // 分析连接失败原因
                analyzeConnectionFailure(targetId);
            }
        };
      
        // 添加 ICE 连接状态监听
        pc.oniceconnectionstatechange = () => {
            console.log(`ICE连接状态 (${targetId}):`, pc.iceConnectionState);
            
            // 只在 ICE 连接失败时处理
            if (pc.iceConnectionState === 'failed') {
                const attempts = (connectionAttempts.get(targetId)?.attempts || 0) + 1;
                if (attempts < 3) {
                    console.log(`ICE 连接失败，尝试重启 ICE...`);
                    pc.restartIce();
                }
            }
        };

        // 修改数据通道状态处理
        dataChannel.onopen = () => {
            console.log(`Data channel to ${targetId} opened`);
            // 确保连接状态正确
            if (pc.connectionState === 'connected') {
                updateConnectionState(targetId, ConnectionState.CONNECTED, {
                    onlineUsers,
                    updateUserList,
                    displayMessage
                });
                // 立即触发 UI 更新
                requestAnimationFrame(() => {
                    updateUIState();
                });
            }
        };

        dataChannel.onclose = () => {
            console.log(`Data channel to ${targetId} closed`);
            // 只在连接仍然存在时处理关闭事件
            if (peerConnections.has(targetId)) {
                const attempts = (connectionAttempts.get(targetId)?.attempts || 0) + 1;
                if (attempts < 3) {
                    console.log(`数据通道关闭，尝试重新建立...`);
                    handleConnectionFailure(targetId);
                    // 立即触发 UI 更新
                    requestAnimationFrame(() => {
                        updateUIState();
                    });
                }
            }
        };

        return pc;
    } catch (err) {
        console.error('创建对等连接失败:', err);
        throw err;
    }
}

function handleConnectionTimeout(targetId) {
    clearConnectionTimeout(targetId);
    
    // 检查用户是否仍然有效
    const userId = onlineUsers.get(targetId);
    if (!userId) {
        console.log(`连接超时的用户 ${targetId} 已不存在，停止重连`);
        return;
    }
    
    displayMessage(`系统: 与 ${userId} 的连接超时，正在重试...`, 'system');
    handleConnectionFailure(targetId); // 直接触发重连
}

function handleConnectionFailure(targetId) {
    clearConnectionTimeout(targetId);
    
    if (!onlineUsers.has(targetId)) {
        console.log(`用户 ${targetId} 已离线，不进行重连`);
        peerConnections.delete(targetId);
        connectionAttempts.delete(targetId);
        updateConnectionState(targetId, ConnectionState.DISCONNECTED, {
            onlineUsers,
            updateUserList,
            displayMessage
        });
        return;
    }
    
    // 检查现有连接状态
    const existingConnection = peerConnections.get(targetId);
    if (existingConnection) {
        const { pc, dataChannel } = existingConnection;
        if (pc.connectionState === 'connected' || 
            pc.connectionState === 'connecting' || 
            dataChannel?.readyState === 'open') {
            console.log('已存在活跃连接，不进行重连');
            return;
        }
    }
    
    // 获取当前重试次数并增加
    const attempts = connectionAttempts.get(targetId)?.attempts || 0;
    connectionAttempts.set(targetId, { attempts: attempts + 1 });
    console.log(`准备第 ${attempts + 1} 次重连...`);
    
    // 使用递增延迟，但设置最大延迟为10秒
    const delay = Math.min(1000 * (attempts + 1), 10000);
    
    setTimeout(async () => {
        try {
            await autoReconnect(targetId);
        } catch (err) {
            console.error('自动重连失败:', err);
        }
    }, delay);
}

async function autoReconnect(targetId) {
    // 清理旧连接
    const oldConnection = peerConnections.get(targetId);
    if (oldConnection) {
        oldConnection.pc.close();
        peerConnections.delete(targetId);
    }
    
    try {
        // 创建新连接
        await createPeerConnection(targetId);
        updateUIState();
    } catch (err) {
        console.error('创建新连接失败:', err);
        // 如果创建失败，触发一次连接失败处理
        handleConnectionFailure(targetId);
    }
}

function clearConnectionTimeout(targetId) {
    const timeoutId = connectionTimeouts.get(targetId);
    if (timeoutId) {
        clearTimeout(timeoutId);
        connectionTimeouts.delete(targetId);
    }
}

export async function reconnect(targetId) {
    const userId = onlineUsers.get(targetId);
    // 检查目标用户是否在线且有效
    if (!userId) {
        console.log(`不重连未知用户 ${targetId}`);
        return;
    }

    try {
        // 重置重连次数
        reconnectAttempts.delete(targetId);
        
        // 清理旧连接
        const oldConnection = peerConnections.get(targetId);
        if (oldConnection) {
            oldConnection.pc.close();
            peerConnections.delete(targetId);
        }
        
        // 创建新连接
        displayMessage(`系统: 正在重新连接 ${onlineUsers.get(targetId)}...`, 'system');
        await createPeerConnection(targetId);
        updateUIState();
    } catch (err) {
        console.error('重新连接失败:', err);
        displayMessage(`系统: 重新连接失败，请稍后再试`, 'system');
    }
}

export async function handleSignal(targetId, signal) {
    try {
        // 获取或创建连接
        let connection = peerConnections.get(targetId);
        if (!connection) {
            console.log(`为 ${targetId} 创建新的连接`);
            await createPeerConnection(targetId);
            connection = peerConnections.get(targetId);
        }
        
        if (!connection || !connection.pc) {
            console.error('无法获取有效的连接对象');
            return;
        }

        const pc = connection.pc;
        
        switch (signal.type) {
            case 'offer':
                try {
                    // 检查状态是否允许设置远程 offer
                    if (pc.signalingState !== 'stable') {
                        console.log('当前状态不是 stable，正在回滚...');
                        await Promise.all([
                            pc.setLocalDescription({type: "rollback"}),
                            pc.setRemoteDescription(signal.offer)
                        ]);
                    } else {
                        await pc.setRemoteDescription(signal.offer);
                    }
                    
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    
                    socket.emit('signal', {
                        to: targetId,
                        signal: { 
                            type: 'answer', 
                            answer: pc.localDescription 
                        }
                    });
                } catch (err) {
                    console.error('处理 offer 失败:', err);
                    console.log('当前信令状态:', pc.signalingState);
                    console.log('当前连接状态:', pc.connectionState);
                    handleConnectionFailure(targetId);
                }
                break;

            case 'answer':
                try {
                    // 检查状态是否允许设置远程 answer
                    if (pc.signalingState === 'have-local-offer') {
                        await pc.setRemoteDescription(signal.answer);
                        console.log(`成功设置来自 ${targetId} 的远程answer`);
                    } else {
                        console.warn(`无法设置远程 answer，当前状态: ${pc.signalingState}`);
                        // 如果状态不对，可能需要重新协商
                        if (pc.signalingState === 'stable') {
                            console.log('触发重新协商...');
                            await pc.createOffer();
                        }
                    }
                } catch (err) {
                    console.error('处理 answer 失败:', err);
                    console.log('当前信令状态:', pc.signalingState);
                    console.log('当前连接状态:', pc.connectionState);
                    handleConnectionFailure(targetId);
                }
                break;

            case 'candidate':
                try {
                    if (signal.candidate) {
                        if (pc.remoteDescription) {
                            await pc.addIceCandidate(signal.candidate);
                        } else {
                            // 如果还没有远程描述，先保存候选项
                            if (!connection.pendingCandidates) {
                                connection.pendingCandidates = [];
                            }
                            connection.pendingCandidates.push(signal.candidate);
                            console.log('保存待处理的 ICE candidate');
                        }
                    }
                } catch (err) {
                    console.error('添加 ICE candidate 失败:', err);
                }
                break;

            default:
                console.log('未知的信令类型:', signal.type);
        }
    } catch (err) {
        console.error('信令处理错误:', err);
        displayMessage(`系统: 连接建立失败，请刷新页面重试`, 'system');
    }
}

// 添加一个函数来处理待处理的 ICE candidates
async function processPendingCandidates(connection) {
    if (connection.pendingCandidates && connection.pendingCandidates.length > 0) {
        console.log(`处理 ${connection.pendingCandidates.length} 个待处理的 ICE candidates`);
        try {
            for (const candidate of connection.pendingCandidates) {
                await connection.pc.addIceCandidate(candidate);
            }
            connection.pendingCandidates = [];
        } catch (err) {
            console.error('处理待处理的 ICE candidates 失败:', err);
        }
    }
}

// 修改 setRemoteDescription 后的处理
async function handleRemoteDescriptionSet(connection) {
    if (connection.pc.remoteDescription) {
        await processPendingCandidates(connection);
    }
}

// 修改 reconnectAllPeers 函数，添加未知用户检查
async function reconnectAllPeers() {
    const disconnectedPeers = [];
    
    // 只检查在线且有效的用户的连接状态
    onlineUsers.forEach((userId, peerId) => {
        // 跳过自己和未知用户
        if (peerId === socket.id || !userId) return;
        
        const connection = peerConnections.get(peerId);
        if (!connection) {
            // 在线用户但没有连接
            disconnectedPeers.push(peerId);
        } else if (connection.pc.connectionState === 'failed' || 
                   connection.pc.connectionState === 'disconnected' || 
                   connection.pc.connectionState === 'closed') {
            // 在线用户但连接已断开
            disconnectedPeers.push(peerId);
        }
    });

    if (disconnectedPeers.length > 0) {
        displayMessage('系统: 正在尝试重新建立连接...', 'system');
        
        // 并行处理所有重连
        await Promise.allSettled(
            disconnectedPeers.map(async (peerId) => {
                // 再次检查用户是否有效
                const userId = onlineUsers.get(peerId);
                if (!userId) {
                    console.log(`跳过未知用户 ${peerId} 的重连`);
                    return;
                }
                
                try {
                    await reconnect(peerId);
                } catch (err) {
                    console.error(`重连 ${peerId} 失败:`, err);
                }
            })
        );
    }
}

// 添加重置连接尝试次数的函数
export function resetConnectionAttempts(targetId) {
    connectionAttempts.delete(targetId);
}

// 分析候选项类型
function getCandidateType(candidate) {
    if (candidate.type === 'relay') {
        return 'TURN';
    } else if (candidate.type === 'srflx') {
        return 'STUN';
    } else if (candidate.type === 'host') {
        return 'HOST';
    }
    return 'UNKNOWN';
}

// 分析连接状态
function analyzeConnection(targetId) {
    const info = candidateInfo.get(targetId);
    if (!info) return;
    
    const candidates = info.candidates;
    const types = new Set(candidates.map(c => c.type));
    
    console.log(`连接分析 (${targetId}):`, {
        可用类型: Array.from(types),
        候选项数量: candidates.length,
        已选择对: info.selectedPair,
        连接耗时: info.selectedPair ? 
            (info.selectedPair.timestamp - info.connectionStartTime) : 
            'N/A'
    });
}

// 分析连接失败原因
function analyzeConnectionFailure(targetId) {
    const info = candidateInfo.get(targetId);
    if (!info) return;
    
    const candidates = info.candidates;
    const connection = peerConnections.get(targetId);
    
    if (!connection) return;
    
    const { pc } = connection;
    console.log(`连接失败分析 (${targetId}):`, {
        ICE状态: pc.iceConnectionState,
        信令状态: pc.signalingState,
        候选项类型: candidates.map(c => c.type),
        连接状态: pc.connectionState
    });
    
    // 如果只有 HOST 候选项，可能是防火墙问题
    if (candidates.every(c => c.type === 'HOST')) {
        console.warn('只收集到本地候选项，可能是防火墙限制');
        displayMessage('系统: 网络连接受限，尝试使用备用服务器...', 'system');
    }
    
    // 如果没有任何候选项，可能是 STUN/TURN 服务器无法访问
    if (candidates.length === 0) {
        console.warn('没有收集到任何候选项，STUN/TURN 服务器可能无法访问');
        displayMessage('系统: 无法访问中继服务器，请检查网络设置', 'system');
    }
}

// 处理 ICE 收集超时
function handleIceGatheringTimeout(targetId) {
    console.warn(`ICE candidate 收集超时 (${targetId})`);
    const connection = peerConnections.get(targetId);
    
    if (connection) {
        // 检查当前连接状态
        const { pc, dataChannel } = connection;
        
        // 如果连接已经建立或正在使用中，不要断开
        if (pc.connectionState === 'connected' || 
            pc.connectionState === 'connecting' || 
            dataChannel?.readyState === 'open') {
            console.log('已存在活跃连接，忽略 ICE 收集超时');
            return;
        }
        
        const candidates = candidateTypes.get(targetId) || [];
        if (candidates.length === 0) {
            // 只有在完全没有收集到候选项，且没有活跃连接时才尝试重连
            console.log('尝试使用备用服务器重新建立连接...');
            handleConnectionFailure(targetId);
        }
    }
}

// 修改 ICE 候选项处理逻辑
function handleIceCandidate(pc, targetId, candidate) {
    if (!candidate) {
        console.log('ICE candidate gathering complete');
        return;
    }

    const type = getCandidateType(candidate);
    const timestamp = Date.now();
    
    if (!candidateInfo.has(targetId)) {
        candidateInfo.set(targetId, {
            candidates: [],
            selectedPair: null,
            connectionStartTime: timestamp
        });
    }
    
    const info = candidateInfo.get(targetId);
    info.candidates.push({
        type,
        timestamp,
        priority: ConnectionPriority[type] || 0,
        candidate
    });

    // 发送候选项到对等端
    socket.emit('signal', {
        to: targetId,
        signal: { type: 'candidate', candidate }
    });
    
    console.log(`发送 ${type} candidate 到 ${targetId}`);
}

// 修改连接状态变化处理
function handleConnectionStateChange(pc, targetId, dataChannel) {
    const info = candidateInfo.get(targetId);
    if (!info) return;

    if (pc.connectionState === 'connected') {
        // 获取选中的候选项对
        const selectedPair = pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair();
        if (selectedPair) {
            info.selectedPair = {
                local: getCandidateType(selectedPair.local),
                remote: getCandidateType(selectedPair.remote),
                timestamp: Date.now()
            };
            
            const connectionTime = info.selectedPair.timestamp - info.connectionStartTime;
            console.log(`连接成功使用 ${info.selectedPair.local} -> ${info.selectedPair.remote} (耗时: ${connectionTime}ms)`);
            
            // 更新UI显示连接类型
            const peerName = onlineUsers.get(targetId) || '未知用户';
            const connType = info.selectedPair.local;
            displayMessage(`系统: 与 ${peerName} 的连接已建立 (${connType})`, 'system');
        }
        
        // 清理其他正在进行的连接尝试
        clearConnectionTimeout(targetId);
    }
}

// ... 其他 WebRTC 相关函数 ... 