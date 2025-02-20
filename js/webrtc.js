import { rtcConfig, iceConfig, CONNECTION_TIMEOUT, ICE_GATHERING_TIMEOUT, ConnectionPriority, DATA_CHANNEL_CONFIG, HEALTH_CHECK_CONFIG, MAX_RECONNECT_ATTEMPTS } from './config.js';
import { socket, onlineUsers } from './socket.js';
import { setupDataChannel } from './dataChannel.js';
import { displayMessage, updateUIState, updateUserList } from './ui.js';
import { ConnectionState, updateConnectionState } from './connectionState.js';

export const peerConnections = new Map(); // key: socketId, value: { pc: RTCPeerConnection, dataChannel: RTCDataChannel }
let connectionTimeouts = new Map(); // 存储连接超时计时器
let reconnectAttempts = new Map(); // 记录重连次数
const connectionAttempts = new Map(); // 存储连接尝试次数
const keepAliveIntervals = new Map(); // 存储保活定时器

// 保活消息间隔（毫秒）
const KEEP_ALIVE_INTERVAL = 5000;
// 最大允许的连续丢失保活消息数
const MAX_MISSED_KEEPALIVE = 3;
// 保活消息计数器
const keepAliveMissed = new Map();

// 添加连接状态监控
let iceGatheringTimeouts = new Map();
let candidateTypes = new Map(); // 记录收集到的候选项类型

// 存储每个连接的候选项信息
const candidateInfo = new Map();

// 存储连接健康检查定时器
const healthCheckIntervals = new Map();
// 存储ICE重启计数器
const iceRestartCounters = new Map();
// 存储最后一次接收到的ICE候选项时间
const lastIceCandidateTime = new Map();

export async function createPeerConnection(targetId) {
    console.log(`Creating peer connection for ${targetId}`);
    
    // 清理现有连接
    if (peerConnections.has(targetId)) {
        cleanupConnection(targetId);
    }

    const userId = onlineUsers.get(targetId);
    // 检查目标用户是否在线且有效
    if (!userId) {
        console.log(`不创建与未知用户 ${targetId} 的连接`);
        return null;
    }

    // 检查是否已经存在活跃连接
    const existingConnection = peerConnections.get(targetId);
    if (existingConnection) {
        if (existingConnection.dataChannel?.readyState === 'open' && 
            existingConnection.pc.connectionState === 'connected') {
            console.log(`已存在与 ${targetId} 的活跃连接，不创建新连接`);
            return existingConnection.pc;
        }
        // 如果连接存在但状态不对，关闭旧连接
        existingConnection.pc.close();
        peerConnections.delete(targetId);
    }

    try {
        // 创建新的RTCPeerConnection
        const pc = new RTCPeerConnection(rtcConfig);
        const dataChannel = pc.createDataChannel('data', {
            ...DATA_CHANNEL_CONFIG,
            negotiated: true,
            id: 0
        });
        
        setupDataChannel(dataChannel, targetId);
        setupKeepAlive(targetId, dataChannel);

        // 存储连接信息
        peerConnections.set(targetId, { pc, dataChannel });

        // 增强的连接状态监控
        pc.onconnectionstatechange = () => {
            console.log(`连接状态变化 (${targetId}):`, pc.connectionState);
            handleConnectionStateChange(pc, targetId, dataChannel);
            
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                clearKeepAlive(targetId);
                handleConnectionFailure(targetId);
            } else if (pc.connectionState === 'connected') {
                resetConnectionAttempts(targetId);
                setupKeepAlive(targetId, dataChannel);
            }
        };

        // 增强的ICE连接状态监控
        pc.oniceconnectionstatechange = () => {
            console.log(`ICE连接状态变化 (${targetId}):`, pc.iceConnectionState);
            if (pc.iceConnectionState === 'failed') {
                handleIceFailure(targetId, pc);
            } else if (pc.iceConnectionState === 'disconnected') {
                setTimeout(() => {
                    if (pc.iceConnectionState === 'disconnected') {
                        handleIceFailure(targetId, pc);
                    }
                }, 3000); // 等待3秒后如果仍然断开则重启ICE
            }
        };

        // 设置数据通道处理
        pc.ondatachannel = (event) => {
            const receivedChannel = event.channel;
            setupDataChannel(receivedChannel, targetId);
            peerConnections.get(targetId).dataChannel = receivedChannel;
        };

        // 设置连接超时
        handleConnectionTimeout(targetId);

        // 只有ID较小的一方主动创建offer
        const shouldCreateOffer = socket.id < targetId;
        
        if (shouldCreateOffer) {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('signal', {
                    to: targetId,
                    signal: { 
                        type: 'offer',
                        sdp: offer.sdp 
                    }
                });
            } catch (error) {
                console.error('创建 offer 失败:', error);
                handleConnectionFailure(targetId);
                return null;
            }
        }

        // 设置ICE候选项处理
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                lastIceCandidateTime.set(targetId, Date.now());
                socket.emit('signal', {
                    to: targetId,
                    from: socket.id,
                    signal: {
                        type: 'candidate',
                        candidate: event.candidate
                    }
                });
            }
        };

        // 启动健康检查
        startHealthCheck(targetId);

        return pc;
    } catch (error) {
        console.error(`创建与 ${targetId} 的连接失败:`, error);
        handleConnectionFailure(targetId);
        return null;
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
    clearKeepAlive(targetId);
    
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
    
    const attempts = connectionAttempts.get(targetId)?.attempts || 0;
    if (attempts >= 3) {
        console.log(`重连次数过多 (${attempts})，停止重连`);
        updateConnectionState(targetId, ConnectionState.FAILED, {
            onlineUsers,
            updateUserList,
            displayMessage
        });
        return;
    }
    
    connectionAttempts.set(targetId, { attempts: attempts + 1 });
    console.log(`准备第 ${attempts + 1} 次重连...`);
    
    const delay = Math.min(1000 * Math.pow(2, attempts), 10000);
    setTimeout(() => autoReconnect(targetId), delay);
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
        let pc = peerConnections.get(targetId)?.pc;
        
        if (!pc) {
            pc = (await createPeerConnection(targetId));
            if (!pc) {
                throw new Error('创建连接失败');
            }
        }

        if (signal.type === 'offer') {
            if (pc.signalingState === 'have-local-offer') {
                // 如果我们已经有一个本地offer，比较ID来决定谁的offer优先
                if (socket.id > targetId) {
                    console.log('收到优先级更高的offer，回滚本地offer');
                    await pc.setLocalDescription({type: "rollback"});
                } else {
                    console.log('忽略优先级较低的offer');
                    return;
                }
            }
            // 确保 signal.sdp 存在且是字符串
            if (typeof signal.sdp !== 'string') {
                console.error('无效的 SDP:', signal.sdp);
                return;
            }
            await pc.setRemoteDescription(new RTCSessionDescription({
                type: 'offer',
                sdp: signal.sdp
            }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('signal', {
                to: targetId,
                signal: { 
                    type: 'answer',
                    sdp: answer.sdp
                }
            });
        } else if (signal.type === 'answer') {
            // 确保 signal.sdp 存在且是字符串
            if (typeof signal.sdp !== 'string') {
                console.error('无效的 SDP:', signal.sdp);
                return;
            }
            await pc.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: signal.sdp
            }));
        } else if (signal.type === 'candidate' && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
    } catch (error) {
        console.error('处理信令失败:', error);
        handleConnectionFailure(targetId);
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

// 设置保活机制
function setupKeepAlive(targetId, dataChannel) {
    clearKeepAlive(targetId);
    keepAliveMissed.set(targetId, 0);
    
    const interval = setInterval(() => {
        if (dataChannel.readyState === 'open') {
            try {
                dataChannel.send(JSON.stringify({
                    type: 'keepalive',
                    timestamp: Date.now()
                }));
                
                const missedCount = keepAliveMissed.get(targetId) || 0;
                if (missedCount > 0) {
                    keepAliveMissed.set(targetId, missedCount - 1);
                }
            } catch (err) {
                console.warn(`发送保活消息失败 (${targetId}):`, err);
                handleKeepAliveFailure(targetId);
            }
        }
    }, KEEP_ALIVE_INTERVAL);
    
    keepAliveIntervals.set(targetId, interval);
}

// 清理保活定时器
function clearKeepAlive(targetId) {
    const interval = keepAliveIntervals.get(targetId);
    if (interval) {
        clearInterval(interval);
        keepAliveIntervals.delete(targetId);
    }
    keepAliveMissed.delete(targetId);
}

// 处理保活失败
function handleKeepAliveFailure(targetId) {
    const missedCount = (keepAliveMissed.get(targetId) || 0) + 1;
    keepAliveMissed.set(targetId, missedCount);
    
    if (missedCount >= MAX_MISSED_KEEPALIVE) {
        console.warn(`连续 ${missedCount} 次未收到保活响应，准备重连...`);
        handleConnectionFailure(targetId);
    }
}

// 处理ICE失败
async function handleIceFailure(targetId, peerConnection) {
    const restartCount = iceRestartCounters.get(targetId) || 0;
    
    if (restartCount < MAX_RECONNECT_ATTEMPTS) {
        console.log(`Attempting ICE restart for ${targetId}, attempt ${restartCount + 1}`);
        
        try {
            // 检查自上次ICE候选项的时间
            const lastTime = lastIceCandidateTime.get(targetId) || 0;
            const timeSinceLastCandidate = Date.now() - lastTime;
            
            if (timeSinceLastCandidate > ICE_GATHERING_TIMEOUT) {
                await restartIce(targetId, peerConnection);
                iceRestartCounters.set(targetId, restartCount + 1);
            }
        } catch (error) {
            console.error('ICE restart failed:', error);
            cleanupConnection(targetId);
        }
    } else {
        console.log(`Max ICE restart attempts reached for ${targetId}`);
        cleanupConnection(targetId);
    }
}

// 重启ICE连接
async function restartIce(targetId, peerConnection) {
    try {
        // 检查信令状态
        if (peerConnection.signalingState === 'have-remote-offer') {
            // 如果我们有远程offer，需要先回滚
            console.log('回滚远程offer以准备ICE重启');
            await peerConnection.setLocalDescription({type: "rollback"});
        } else if (peerConnection.signalingState !== 'stable') {
            console.log(`当前信令状态不适合ICE重启: ${peerConnection.signalingState}`);
            return;
        }

        console.log('创建带有ICE重启的offer');
        const offer = await peerConnection.createOffer({ 
            iceRestart: true,
            offerToReceiveAudio: false,
            offerToReceiveVideo: false
        });
        
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('signal', {
            to: targetId,
            from: socket.id,
            signal: {
                type: 'offer',
                sdp: offer.sdp
            }
        });
    } catch (error) {
        console.error('Error during ICE restart:', error);
        throw error;
    }
}

// 启动连接健康检查
function startHealthCheck(targetId) {
    if (healthCheckIntervals.has(targetId)) {
        clearInterval(healthCheckIntervals.get(targetId));
    }

    const interval = setInterval(async () => {
        const connection = peerConnections.get(targetId);
        if (!connection) {
            clearInterval(interval);
            return;
        }

        const dataChannel = connection.dataChannel;
        if (!dataChannel || dataChannel.readyState !== 'open') {
            console.log(`Data channel not ready for ${targetId}`);
            handleIceFailure(targetId, connection.pc);
            return;
        }

        // 发送健康检查消息
        try {
            dataChannel.send(JSON.stringify({
                type: 'health_check',
                timestamp: Date.now()
            }));
        } catch (error) {
            console.error('Health check failed:', error);
            handleIceFailure(targetId, connection.pc);
        }
    }, HEALTH_CHECK_CONFIG.interval);

    healthCheckIntervals.set(targetId, interval);
}

// 清理连接
function cleanupConnection(targetId) {
    console.log(`Cleaning up connection for ${targetId}`);
    
    // 清理健康检查定时器
    if (healthCheckIntervals.has(targetId)) {
        clearInterval(healthCheckIntervals.get(targetId));
        healthCheckIntervals.delete(targetId);
    }

    // 清理数据通道
    if (peerConnections.has(targetId)) {
        const connection = peerConnections.get(targetId);
        if (connection) {
            connection.dataChannel.close();
        }
        peerConnections.delete(targetId);
    }

    // 清理其他状态
    iceRestartCounters.delete(targetId);
    lastIceCandidateTime.delete(targetId);
}

// ... 其他 WebRTC 相关函数 ... 