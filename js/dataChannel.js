import { peerConnections } from './webrtc.js';
import { handleFileTransfer, handleFileChunk, handleFileAccept } from './fileTransfer.js';
import { displayMessage, updateUIState } from './ui.js';
import { onlineUsers } from './socket.js';
import { TransferState } from './config.js';

export function setupDataChannel(channel, targetId) {
  channel.onopen = () => {
    console.log(`与 ${targetId} 的数据通道已打开`);
    displayMessage(`系统: 与 ${onlineUsers.get(targetId)} 的连接已建立`, 'system');
    updateUIState();
  };

  channel.onmessage = ({ data }) => {
    try {
      if (typeof data === 'string') {
        const message = JSON.parse(data);
        handleMessage(message, targetId);
      }
    } catch (error) {
      console.error('处理消息失败:', error);
    }
  };

  channel.onerror = (event) => {
    // 检查是否是用户主动关闭导致的错误
    if (event.error.message === 'User-Initiated Abort, reason=Close called') {
      console.log(`与 ${targetId} 的数据通道已被用户关闭`);
      return;
    }
    
    // 处理其他错误
    console.error(`与 ${targetId} 的数据通道错误:`, event.error);
    displayMessage(`系统: 与 ${onlineUsers.get(targetId)} 的连接出现错误`, 'system');
  };

  channel.onclose = () => {
    console.log(`与 ${targetId} 的数据通道已关闭`);
    // 只有在非用户主动关闭的情况下显示消息
    if (channel.readyState !== 'closing') {
      displayMessage(`系统: 与 ${onlineUsers.get(targetId)} 的连接已断开`, 'system');
    }
    updateUIState();
  };
}

function handleMessage(message, senderId) {
  switch (message.type) {
    case 'text':
      const senderName = onlineUsers.get(senderId) || '未知用户';
      displayMessage(`${senderName}: ${message.text}`, 'text');
      break;
      
    case 'file-chunk':
      handleFileChunk({
        fileId: message.fileId,
        chunkIndex: message.chunkIndex,
        data: message.data,
        totalChunks: message.totalChunks
      }, senderId);
      break;
      
    case 'file':
      handleFileTransfer(message, senderId);
      break;
      
    case 'file-accept':
      console.log('收到文件接收确认消息:', message);
      handleFileAccept(message, senderId);
      break;
      
    default:
      console.log('未知消息类型:', message.type);
  }
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

    // 发送消息给所有连接的用户
    peerConnections.forEach(({ dataChannel }, peerId) => {
      if (dataChannel?.readyState === 'open') {
        try {
          dataChannel.send(JSON.stringify({
            type: 'text',
            text: message
          }));
        } catch (error) {
          console.error(`向 ${peerId} 发送消息失败:`, error);
        }
      }
    });
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