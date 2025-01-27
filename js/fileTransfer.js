import { fileChunkSize, TransferState } from './config.js';
import { peerConnections } from './webrtc.js';
import { socket } from './socket.js';
import { displayMessage, updateProgressBar } from './ui.js';

export const ongoingTransfers = {};
export const fileTransferStatus = new Map();
export const transferSpeeds = new Map();
let lastTransferTime = new Map();

export function handleFileTransfer(message, senderId) {
  const { fileId, fileName, fileType, fileSize, chunks } = message;
  console.log(`处理来自 ${senderId} 的文件传输请求: `, message);
  
  if (!ongoingTransfers[fileId]) {
    ongoingTransfers[fileId] = {
      fileName,
      fileType,
      fileSize,
      chunks,
      receivedChunks: new Array(chunks).fill(null),
      startTime: Date.now(),
      state: TransferState.WAITING,
      senderId
    };
  }
  
  displayMessage(message, 'file');
}

export function handleFileChunk(message, senderId) {
  const { fileId, chunkIndex, data, totalChunks } = message;
  const transfer = ongoingTransfers[fileId];
  
  if (!transfer) {
    console.error(`未找到文件传输记录: ${fileId}`);
    return;
  }
  
  // 更新接收进度
  transfer.receivedChunks[chunkIndex] = data;
  const receivedCount = transfer.receivedChunks.filter(chunk => chunk !== null).length;
  const progress = Math.round((receivedCount / totalChunks) * 100);
  
  // 计算传输速度
  const now = Date.now();
  const lastTime = lastTransferTime.get(fileId) || transfer.startTime;
  const timeDiff = now - lastTime;
  const bytesReceived = data.length;
  
  if (timeDiff > 0) {
    const speed = bytesReceived / (timeDiff / 1000); // bytes per second
    transferSpeeds.set(fileId, speed);
    lastTransferTime.set(fileId, now);
  }
  
  // 更新UI显示
  updateProgressBar(fileId, progress, 'download', transferSpeeds.get(fileId));
  
  // 检查是否接收完成
  if (receivedCount === totalChunks) {
    completeFileTransfer(fileId);
  }
}

export async function handleFileAccept(message, senderId) {
  const { fileId } = message;
  const transfer = ongoingTransfers[fileId];
  
  if (!transfer) {
    console.error(`未找到文件传输记录: ${fileId}`);
    return;
  }
  
  const connection = peerConnections.get(senderId);
  if (!connection?.dataChannel || connection.dataChannel.readyState !== 'open') {
    console.error(`与 ${senderId} 的连接不可用`);
    return;
  }
  
  try {
    await sendFileChunks(transfer.file, fileId, senderId);
  } catch (error) {
    console.error('发送文件失败:', error);
    displayMessage('系统: 发送文件失败', 'system');
  }
}

export function sendFile() {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];
  
  if (!file) {
    console.log('没有选择文件');
    return;
  }
  
  if (!hasActiveConnections()) {
    displayMessage('系统: 没有可用的连接，无法发送文件', 'system');
    return;
  }
  
  const fileId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const chunks = Math.ceil(file.size / fileChunkSize);
  
  ongoingTransfers[fileId] = {
    file,
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
    chunks,
    state: TransferState.WAITING,
    startTime: Date.now(),
    pendingPeers: new Set(),
    acceptedPeers: new Set()
  };
  
  // 向所有连接的用户发送文件传输请求
  peerConnections.forEach(({ dataChannel }, peerId) => {
    if (dataChannel && dataChannel.readyState === 'open') {
      const fileInfo = {
        type: 'file',
        fileId,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        chunks,
        senderId: socket.id
      };
      
      try {
        dataChannel.send(JSON.stringify(fileInfo));
        ongoingTransfers[fileId].pendingPeers.add(peerId);
      } catch (error) {
        console.error(`向 ${peerId} 发送文件请求失败:`, error);
      }
    }
  });
  
  // 显示发送方的文件消息
  displayMessage({
    fileId,
    fileName: file.name,
    fileSize: file.size,
    senderId: socket.id
  }, 'file');
}

async function sendFileChunks(file, fileId, peerId) {
  const connection = peerConnections.get(peerId);
  if (!connection?.dataChannel || connection.dataChannel.readyState !== 'open') {
    throw new Error('数据通道未就绪');
  }
  
  const { dataChannel } = connection;
  const chunkSize = fileChunkSize;
  const totalChunks = Math.ceil(file.size / chunkSize);
  let offset = 0;
  
  for (let i = 0; i < totalChunks; i++) {
    const chunk = file.slice(offset, offset + chunkSize);
    const arrayBuffer = await chunk.arrayBuffer();
    const chunkData = {
      type: 'file-chunk',
      fileId,
      chunkIndex: i,
      totalChunks,
      data: Array.from(new Uint8Array(arrayBuffer))
    };
    
    await sendWithBackPressure(dataChannel, JSON.stringify(chunkData));
    
    offset += chunkSize;
    const progress = Math.round((i + 1) / totalChunks * 100);
    updateProgressBar(fileId, progress, 'upload');
  }
}

async function sendWithBackPressure(channel, data) {
  return new Promise((resolve) => {
    if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
      const onBufferLow = () => {
        channel.removeEventListener('bufferedamountlow', onBufferLow);
        channel.send(data);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', onBufferLow);
    } else {
      channel.send(data);
      resolve();
    }
  });
}

export function completeFileTransfer(fileId) {
  const transfer = ongoingTransfers[fileId];
  if (!transfer) return;
  
  const blob = new Blob(transfer.receivedChunks.map(chunk => new Uint8Array(chunk)), {
    type: transfer.fileType || 'application/octet-stream'
  });
  
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = transfer.fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
  
  delete ongoingTransfers[fileId];
  transferSpeeds.delete(fileId);
  lastTransferTime.delete(fileId);
  
  displayMessage(`系统: 文件 ${transfer.fileName} 下载完成`, 'system');
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

export function acceptFileTransfer(fileId, senderId) {
  const transfer = ongoingTransfers[fileId];
  if (!transfer) {
    console.error(`未找到文件传输记录: ${fileId}`);
    return;
  }
  
  const connection = peerConnections.get(senderId);
  if (!connection?.dataChannel || connection.dataChannel.readyState !== 'open') {
    console.error(`与 ${senderId} 的连接不可用`);
    return;
  }
  
  try {
    connection.dataChannel.send(JSON.stringify({
      type: 'file-accept',
      fileId
    }));
    
    transfer.state = TransferState.DOWNLOADING;
    displayMessage(`系统: 开始接收文件 ${transfer.fileName}`, 'system');
  } catch (error) {
    console.error('发送文件接收确认失败:', error);
    displayMessage('系统: 接收文件失败', 'system');
  }
} 