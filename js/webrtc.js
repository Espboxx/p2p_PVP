import { rtcConfig } from './config.js';
import { socket } from './socket.js';
import { setupDataChannel } from './dataChannel.js';
import { displayMessage, updateUIState, showReconnectButton } from './ui.js';
import { onlineUsers } from './socket.js';

export const peerConnections = new Map(); // key: socketId, value: { pc: RTCPeerConnection, dataChannel: RTCDataChannel }
const CONNECTION_TIMEOUT = 20000; // 20秒超时
const RECONNECT_ATTEMPTS = 3; // 最大重连次数
const RECONNECT_DELAY = 2000; // 重连延迟(ms)
let connectionTimeouts = new Map(); // 存储连接超时计时器
let reconnectAttempts = new Map(); // 记录重连次数

export async function createPeerConnection(targetId) {
    // 检查目标用户是否在线
    if (!onlineUsers.has(targetId)) {
        console.log(`不创建与未知用户 ${targetId} 的连接`);
        return null;
    }

    try {
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
            console.log(`连接状态 (${targetId}):`, pc.connectionState);
            if (pc.connectionState === 'connected') {
                clearConnectionTimeout(targetId);
                const peerName = onlineUsers.get(targetId) || '未知用户';
                displayMessage(`系统: 已与 ${peerName} 建立连接`, 'system');
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
        return pc;
    } catch (err) {
        console.error('创建对等连接失败:', err);
        if (onlineUsers.has(targetId)) {
            displayMessage('系统: 创建连接失败，正在尝试重新连接...', 'system');
            await reconnectAllPeers();
        }
        throw err;
    }
}

function handleConnectionTimeout(targetId) {
    console.log(`与 ${targetId} 的连接超时`);
    const connection = peerConnections.get(targetId);
    if (connection) {
        connection.pc.close();
        peerConnections.delete(targetId);
    }
    
    displayMessage(`系统: 与 ${onlineUsers.get(targetId) || '未知用户'} 的连接超时`, 'system');
    showReconnectButton(targetId);
    updateUIState();
}

function handleConnectionFailure(targetId) {
    clearConnectionTimeout(targetId);
    
    // 检查用户是否还在线
    if (!onlineUsers.has(targetId)) {
        console.log(`用户 ${targetId} 已离线，不进行重连`);
        peerConnections.delete(targetId);
        updateUIState();
        return;
    }
    
    // 检查是否还需要继续重连
    const attempts = reconnectAttempts.get(targetId) || 0;
    if (attempts < RECONNECT_ATTEMPTS) {
        reconnectAttempts.set(targetId, attempts + 1);
        
        // 显示重连提示
        const peerName = onlineUsers.get(targetId);
        displayMessage(`系统: 与 ${peerName} 的连接已断开，正在进行第 ${attempts + 1}/${RECONNECT_ATTEMPTS} 次重连...`, 'system');
        
        // 延迟一段时间后尝试重连
        setTimeout(async () => {
            try {
                await autoReconnect(targetId);
                // 如果这次重连失败，尝试重新连接所有未连接的用户
                if (attempts + 1 === RECONNECT_ATTEMPTS) {
                    await reconnectAllPeers();
                }
            } catch (err) {
                console.error('自动重连失败:', err);
                if (attempts + 1 === RECONNECT_ATTEMPTS) {
                    await reconnectAllPeers();
                }
            }
        }, RECONNECT_DELAY);
    } else {
        // 重连次数用完，显示手动重连按钮
        peerConnections.delete(targetId);
        console.log(`已移除与 ${targetId} 的对等连接`);
        
        if (onlineUsers.has(targetId)) {
            displayMessage(`系统: 与 ${onlineUsers.get(targetId)} 的连接已断开，自动重连失败`, 'system');
            showReconnectButton(targetId);
        }
        
        updateUIState();
        reconnectAttempts.delete(targetId);
        reconnectAllPeers();
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
    // 检查目标用户是否在线
    if (!onlineUsers.has(targetId)) {
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

// 修改 reconnectAllPeers 函数，只重连在线用户
async function reconnectAllPeers() {
    const disconnectedPeers = [];
    
    // 只检查在线用户的连接状态
    onlineUsers.forEach((userId, peerId) => {
        // 跳过自己
        if (peerId === socket.id) return;
        
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
                try {
                    await reconnect(peerId);
                } catch (err) {
                    console.error(`重连 ${peerId} 失败:`, err);
                }
            })
        );
    }
}

// ... 其他 WebRTC 相关函数 ... 