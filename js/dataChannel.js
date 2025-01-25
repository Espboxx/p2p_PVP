import { peerConnections } from './webrtc.js';
import { handleFileTransfer, handleFileChunk, handleFileAccept, handleChunkData, ongoingTransfers } from './fileTransfer.js';
import { displayMessage, updateUIState, showFileReceivePrompt, updateProgressBar } from './ui.js';
import { onlineUsers } from './socket.js';
import { socket } from './socket.js';
import { TransferState } from './config.js';

export function setupDataChannel(channel, targetId) {
  channel.onopen = () => {
    console.log(`与 ${targetId} 的数据通道已打开`);
    
    // 检查是否有暂停的传输需要恢复
    Object.entries(ongoingTransfers).forEach(([fileId, transfer]) => {
      if (transfer.state === TransferState.PAUSED) {
        if (transfer.senderId === socket.id) {
          resumeFileTransfer(fileId, targetId);
        } else if (transfer.senderId === targetId) {
          requestResendChunks(fileId, targetId);
        }
      }
    });
    
    updateUIState();
  };

  channel.onmessage = async ({ data }) => {
    console.log(`从 ${targetId} 收到的数据类型:`, typeof data);
    const connection = peerConnections.get(targetId);
    if (!connection) {
      console.log(`无效的连接: ${targetId}`);
      return;
    }

    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        console.log(`解析后的消息类型: ${message.type}`);
        
        if (message.type === 'text') {
          const senderName = onlineUsers.get(targetId) || '未知用户';
          console.log(`显示消息: ${senderName}: ${message.text}`);
          displayMessage(`${senderName}: ${message.text}`, 'text');
        } else if (message.type === 'file') {
          console.log('收到文件传输请求:', message);
          
          // 检查是否已经在处理这个文件
          if (ongoingTransfers[message.fileId]) {
            const transfer = ongoingTransfers[message.fileId];
            if (transfer.state === TransferState.DOWNLOADING || 
                transfer.state === TransferState.COMPLETED) {
              console.log('文件已在下载或已完成，忽略请求');
              return;
            }
          }
          
          // 显示接收提示并等待用户响应
          const userResponse = await showFileReceivePrompt({
            ...message,
            senderId: targetId
          });

          if (userResponse) {
            // 使用已有的 updateProgressBar 函数更新UI状态
            updateProgressBar(message.fileId, 0, 'download');
            handleFileTransfer(message, targetId);
            channel.send(JSON.stringify({
              type: 'file-accept',
              fileId: message.fileId,
              receiverId: socket.id
            }));
          } else {
            channel.send(JSON.stringify({
              type: 'file-reject',
              fileId: message.fileId,
              receiverId: socket.id
            }));
          }
        } else if (message.type === 'chunk') {
          console.log(`收到文件块 ${message.chunkIndex}/${message.chunks}`);
          handleFileChunk(message, targetId);
        } else if (message.type === 'file-accept') {
          console.log('收到文件接受确认:', message);
          handleFileAccept(message, targetId);
        } else if (message.type === 'file-reject') {
          console.log('收到文件拒绝消息:', message);
          // 处理文件拒绝逻辑
          if (ongoingTransfers[message.fileId]) {
            ongoingTransfers[message.fileId].pendingPeers.delete(targetId);
          }
        } else {
          console.log('未知的消息类型:', message.type);
        }
      } catch (e) {
        console.error('消息处理错误:', e);
      }
    } else if (data instanceof ArrayBuffer || data instanceof Blob) {
      console.log('收到二进制数据:', data.byteLength || data.size, '字节');
      handleChunkData(data, targetId);
    }
  };

  channel.onerror = (error) => {
    console.error(`与 ${targetId} 的数据通道错误:`, error);
  };

  channel.onclose = () => {
    console.log(`与 ${targetId} 的数据通道已关闭`);
    updateUIState();
  };
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

    // 发送给所有连接的用户
    peerConnections.forEach(({ dataChannel }, peerId) => {
      if (dataChannel && dataChannel.readyState === 'open') {
        console.log(`发送到 ${peerId}: ${message}`);
        dataChannel.send(JSON.stringify({ 
          type: 'text',   
          text: message 
        }));
      }
    });
    displayMessage(`我: ${message}`, 'text');
    input.value = '';
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