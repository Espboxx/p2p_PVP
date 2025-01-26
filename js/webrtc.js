import { rtcConfig } from './config.js';
import { socket, onlineUsers } from './socket.js';
import { setupDataChannel } from './dataChannel.js';
import { displayMessage, updateUIState, showReconnectButton, updateUserList } from './ui.js';
import { ConnectionState, updateConnectionState } from './connectionState.js';

export const peerConnections = new Map(); // key: socketId, value: { pc: RTCPeerConnection, dataChannel: RTCDataChannel }
const CONNECTION_TIMEOUT = 20000; // 20秒超时
let connectionTimeouts = new Map(); // 存储连接超时计时器
let reconnectAttempts = new Map(); // 记录重连次数
const connectionAttempts = new Map(); // 存储连接尝试次数

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
        
        pc.onicecandidate = ({ candidate }) => {
            if (candidate) {
                socket.emit('signal', { 
                    to: targetId, 
                    signal: { type: 'candidate', candidate } 
                });
                console.log(`发送 ICE candidate 到 ${targetId}`);
            } else {
                console.log('ICE gathering complete');
            }
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
            console.log(`Connection state changed to: ${pc.connectionState} for peer ${targetId}`);
            
            let connectionState;
            if (dataChannel.readyState === 'open') {
                connectionState = ConnectionState.CONNECTED;
            } else if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
                connectionState = ConnectionState.CONNECTING;
            } else if (pc.connectionState === 'failed' || 
                      pc.connectionState === 'disconnected' || 
                      pc.connectionState === 'closed') {
                const connectionInfo = connectionAttempts.get(targetId);
                if (connectionInfo && connectionInfo.attempts >= 3) {
                    connectionState = ConnectionState.FAILED;
                } else {
                    connectionState = ConnectionState.DISCONNECTED;
                }
            }

            // 更新本地状态
            if (connectionState) {
                updateConnectionState(targetId, connectionState, {
                    onlineUsers,
                    updateUserList,
                    displayMessage
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
                updateUIState();
            } else if (pc.connectionState === 'failed' || 
                      pc.connectionState === 'disconnected' || 
                      pc.connectionState === 'closed') {
                handleConnectionFailure(targetId);
            }
        };
      
        // 添加ICE连接状态变化监听
        pc.oniceconnectionstatechange = () => {
            console.log(`ICE连接状态 (${targetId}):`, pc.iceConnectionState);
            const peerName = onlineUsers.get(targetId) || '未知用户';
            
            if (pc.iceConnectionState === 'connected') {
                displayMessage(`系统: 与 ${peerName} 的网络连接已建立`, 'system');
                // 连接成功时重置重连次数
                reconnectAttempts.delete(targetId);
            } else if (pc.iceConnectionState === 'disconnected') {
                displayMessage(`系统: 与 ${peerName} 的网络连接已断开，正在尝试重连...`, 'system');
                handleConnectionFailure(targetId);
            } else if (pc.iceConnectionState === 'failed') {
                displayMessage(`系统: 与 ${peerName} 的网络连接失败`, 'system');
                handleConnectionFailure(targetId);
            }
        };

        // 修改数据通道状态变化监听
        dataChannel.onopen = () => {
            console.log(`Data channel to ${targetId} opened`);
            resetConnectionAttempts(targetId); // 重置重连次数
            
            updateConnectionState(targetId, ConnectionState.CONNECTED, {
                onlineUsers,
                updateUserList,
                displayMessage
            });
            
            socket.emit('connection-state-change', {
                targetId,
                state: pc.connectionState,
                dataChannelState: 'open'
            });
        };

        dataChannel.onclose = () => {
            console.log(`Data channel to ${targetId} closed`);
            
            // 获取或初始化连接尝试信息
            let attempts = connectionAttempts.get(targetId)?.attempts || 0;
            connectionAttempts.set(targetId, { attempts: attempts + 1 });
            
            // 根据重试次数决定状态
            const state = attempts >= 3 ? 
                         ConnectionState.FAILED : ConnectionState.DISCONNECTED;
            
            updateConnectionState(targetId, state, {
                onlineUsers,
                updateUserList,
                displayMessage
            });
            
            socket.emit('connection-state-change', {
                targetId,
                state: pc.connectionState,
                dataChannelState: 'closed'
            });
            
            // 如果还没达到最大重试次数，尝试重连
            if (attempts < 3 && onlineUsers.has(targetId)) {
                console.log(`准备第 ${attempts + 1} 次重连...`);
                setTimeout(() => {
                    reconnect(targetId).catch(err => {
                        console.error(`重连失败 (尝试 ${attempts + 1}/3):`, err);
                    });
                }, 1000 * (attempts + 1)); // 递增重连延迟
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
    } else {
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

export async function handleSignal(from, signal) {
    try {
        let connection = peerConnections.get(from);
        if (!connection) {
            connection = { pc: await createPeerConnection(from) };
            peerConnections.set(from, connection);
        }
        const pc = connection.pc;

        switch (signal.type) {
            case 'offer':
                // 确保在设置远程描述前处于稳定状态
                if (pc.signalingState !== 'stable') {
                    console.log('信令状态不稳定，等待回滚...');
                    await Promise.all([
                        pc.setLocalDescription({ type: 'rollback' }),
                        pc.setRemoteDescription(signal.offer)
                    ]);
                } else {
                    await pc.setRemoteDescription(signal.offer);
                }
                
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                
                socket.emit('signal', {
                    to: from,
                    signal: { type: 'answer', answer }
                });
                break;

            case 'answer':
                // 只在有待处理的 offer 时设置 answer
                if (pc.signalingState === 'have-local-offer') {
                    await pc.setRemoteDescription(signal.answer);
                } else {
                    console.log('忽略 answer，当前状态:', pc.signalingState);
                }
                break;

            case 'candidate':
                // 只在连接建立后添加 ICE candidate
                if (pc.remoteDescription) {
                    await pc.addIceCandidate(signal.candidate);
                } else {
                    console.log('延迟处理 ICE candidate，等待远程描述...');
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

// ... 其他 WebRTC 相关函数 ... 