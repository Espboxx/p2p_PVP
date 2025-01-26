import { peerConnections } from './webrtc.js';
import { handleFileTransfer, handleFileChunk, handleFileAccept, handleChunkData, ongoingTransfers } from './fileTransfer.js';
import { displayMessage, updateUIState, showFileReceivePrompt, updateProgressBar } from './ui.js';
import { onlineUsers } from './socket.js';
import { socket } from './socket.js';
import { TransferState } from './config.js';
import { cryptoHelper } from './crypto.js';

export async function setupDataChannel(channel, targetId) {
  // 初始化连接状态Promise
  const connectionPromise = new Promise((resolve, reject) => {
    const connection = peerConnections.get(targetId);
    if (!connection) {
      peerConnections.set(targetId, {
        connectionResolve: resolve,
        connectionReject: reject
      });
    } else {
      connection.connectionResolve = resolve;
      connection.connectionReject = reject;
    }
  });

  // 初始化密钥交换Promise
  const keyExchangePromise = new Promise((resolve) => {
    peerConnections.get(targetId).keyExchangeResolve = resolve;
  });

  // 标记是否已完成密钥交换
  let keyExchangeCompleted = false;

  channel.onopen = async () => {
    console.log(`与 ${targetId} 的数据通道已打开，正在进行加密握手...`);
    displayMessage('系统: 正在建立加密连接...', 'system');
    
    try {
      // 确保 cryptoHelper 已初始化
      if (!window.cryptoHelper) {
        window.cryptoHelper = new CryptoHelper();
      }

      // 确保密钥对已生成
      if (!window.cryptoHelper.keyPair) {
        await window.cryptoHelper.generateKeyPair();
      }

      const publicKey = await window.cryptoHelper.exportPublicKey();
      channel.send(JSON.stringify({
        type: 'public-key',
        key: Array.from(publicKey)
      }));
    } catch (error) {
      console.error('生成或发送公钥失败:', error);
      displayMessage(`系统: 加密连接失败 - ${error.message}`, 'system');
      channel.close();
    }
  };

  channel.onmessage = async ({ data }) => {
    try {
      if (typeof data === 'string') {
        const message = JSON.parse(data);
        
        if (message.type === 'public-key') {
          try {
            // 确保本地密钥对已生成
            if (!window.cryptoHelper.keyPair) {
              await window.cryptoHelper.generateKeyPair();
            }
            
            // 处理收到的公钥
            const publicKey = await cryptoHelper.importPublicKey(new Uint8Array(message.key));
            await cryptoHelper.deriveSharedKey(publicKey, targetId);
            keyExchangeCompleted = true;
            
            const connection = peerConnections.get(targetId);
            if (connection?.keyExchangeResolve) {
              connection.keyExchangeResolve();
            }
            
            // 发送连接测试消息
            await sendConnectionTest(targetId);
            
            // 启动连接测试超时计时器
            const timeoutId = setTimeout(() => {
              const conn = peerConnections.get(targetId);
              if (conn?.connectionReject) {
                conn.connectionReject(new Error('连接测试超时'));
              }
            }, 5000); // 5秒超时
            
            if (connection) {
              connection.testTimeoutId = timeoutId;
            }
            
            return;
          } catch (error) {
            console.error('处理公钥失败:', error);
            displayMessage('系统: 密钥交换失败，请重试', 'system');
            channel.close();
            return;
          }
        }
        
        // 只有在完成密钥交换后才处理加密消息
        if (message.encrypted) {
          if (!keyExchangeCompleted) {
            console.warn('收到加密消息但密钥交换未完成');
            return;
          }
          
          try {
            // 解密数据
            const decrypted = await cryptoHelper.decrypt(
              new Uint8Array(message.encrypted),
              new Uint8Array(message.iv),
              targetId
            );
            
            // 处理连接测试消息
            if (decrypted.type === 'connection-test') {
              handleConnectionTest(decrypted, targetId);
              return;
            }
            
            if (decrypted.type === 'connection-test-response') {
              handleConnectionTestResponse(targetId);
              return;
            }
            
            // 处理其他消息
            handleDecryptedMessage(decrypted, targetId);
          } catch (error) {
            console.error('解密消息失败:', error);
          }
        }
      }
    } catch (error) {
      console.error('处理消息失败:', error);
    }
  };

  channel.onerror = (error) => {
    console.error(`与 ${targetId} 的数据通道错误:`, error);
  };

  channel.onclose = () => {
    console.log(`与 ${targetId} 的数据通道已关闭`);
    updateUIState();
  };

  // 为连接对象添加发送加密消息的方法
  peerConnections.get(targetId).sendEncryptedMessage = async (message) => {
    try {
      if (!keyExchangeCompleted) {
        await keyExchangePromise;
      }
      return sendEncryptedMessage(message, targetId);
    } catch (error) {
      console.error('发送加密消息失败:', error);
      throw error;
    }
  };

  return connectionPromise;
}

export function sendMessage() {
  const input = document.getElementById('messageInput');
  const message = input.value.trim();
  if (message) {
    console.log(`发送消息: ${message}`);
    
    // 如果没有其他用户，只显示自己的消息
    if (peerConnections.size === 0) {
      displayMessage(`我: ${message}`, 'text');
      input.value = '';
      return;
    }
    
    // 有其他用户但没有活跃连接时
    if (!hasActiveConnections()) {
      displayMessage('系统: 正在建立连接，请稍后重试', 'system');
      return;
    }

    // 先显示自己的消息
    displayMessage(`我: ${message}`, 'text');
    input.value = '';

    let sendPromises = [];
    // 发送加密消息给所有连接的用户
    peerConnections.forEach((connection, peerId) => {
      if (connection.dataChannel?.readyState === 'open' && connection.sendEncryptedMessage) {
        try {
          const promise = connection.sendEncryptedMessage({
            type: 'text',
            text: message
          }).catch(error => {
            console.error(`向 ${peerId} 发送消息失败:`, error);
          });
          sendPromises.push(promise);
        } catch (error) {
          console.error(`准备发送消息到 ${peerId} 失败:`, error);
        }
      }
    });

    // 只处理发送失败的情况
    Promise.all(sendPromises).catch(error => {
      console.error('发送消息时发生错误:', error);
      displayMessage('系统: 发送消息失败', 'system');
    });
  }
}

// 发送加密消息
export async function sendEncryptedMessage(message, peerId) {
  const connection = peerConnections.get(peerId);
  if (connection?.dataChannel?.readyState === 'open') {
    try {
      const encrypted = await cryptoHelper.encrypt(message, peerId);
      connection.dataChannel.send(JSON.stringify({
        encrypted: Array.from(encrypted.encrypted),
        iv: Array.from(encrypted.iv)
      }));
    } catch (error) {
      console.error('发送加密消息失败:', error);
      throw error;
    }
  }
}

function hasActiveConnections() {
  let hasActive = false;
  peerConnections.forEach(({ dataChannel }) => {
    if (dataChannel && dataChannel.readyState === 'open') {
      hasActive = true;
    }
  });
  return hasActive;
}

// 处理解密后的消息
export function handleDecryptedMessage(decrypted, senderId) {
  console.log('收到解密消息:', decrypted.type, decrypted);  // 添加日志
  
  switch (decrypted.type) {
    case 'text':
      const senderName = onlineUsers.get(senderId) || '未知用户';
      displayMessage(`${senderName}: ${decrypted.text}`, 'text');
      break;
      
    case 'file-chunk':
      handleFileChunk({
        fileId: decrypted.fileId,
        chunkIndex: decrypted.chunkIndex,
        data: decrypted.data,
        totalChunks: decrypted.totalChunks
      }, senderId);
      break;
      
    case 'file':
      handleFileTransfer(decrypted, senderId);
      break;
      
    case 'file-accept':
      console.log('收到文件接收确认消息:', decrypted);  // 添加日志
      handleFileAccept(decrypted, senderId);
      break;
      
    case 'connection-test':
      handleConnectionTest(decrypted, senderId);
      break;
      
    case 'connection-test-response':
      handleConnectionTestResponse(senderId);
      break;

    
      
    default:
      console.log('未知消息类型:', decrypted.type);
  }
}

// 发送连接测试消息
async function sendConnectionTest(targetId) {
  try {
    await sendEncryptedMessage({
      type: 'connection-test',
      timestamp: Date.now()
    }, targetId);
  } catch (error) {
    console.error('发送连接测试消息失败:', error);
    throw error;
  }
}

// 处理收到的连接测试消息
async function handleConnectionTest(message, senderId) {
  try {
    // 发送测试响应
    await sendEncryptedMessage({
      type: 'connection-test-response',
      timestamp: message.timestamp
    }, senderId);
  } catch (error) {
    console.error('发送连接测试响应失败:', error);
  }
}

// 处理连接测试响应
function handleConnectionTestResponse(targetId) {
  const connection = peerConnections.get(targetId);
  if (connection) {
    // 清除超时计时器
    if (connection.testTimeoutId) {
      clearTimeout(connection.testTimeoutId);
    }
    
    // 标记连接成功
    if (connection.connectionResolve) {
      connection.connectionResolve();
      displayMessage(`系统: 与 ${onlineUsers.get(targetId) || '未知用户'} 的加密连接已建立`, 'system');
    }
    
    updateUIState();
  }
} 