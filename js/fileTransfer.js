import { FILE_CONFIG, TransferState, DATA_CHANNEL_CONFIG } from './config.js';
import { peerConnections } from './webrtc.js';
import { socket } from './socket.js';
import { displayMessage, updateProgressBar, showError } from './ui.js';

export const ongoingTransfers = new Map();
export const fileTransferStatus = new Map();
export const transferSpeeds = new Map();
const lastTransferTime = new Map();
const transferBuffers = new Map();

// 文件传输状态管理
class FileTransfer {
  constructor(fileId, fileName, fileType, fileSize, chunks, senderId) {
    this.fileId = fileId;
    this.fileName = fileName;
    this.fileType = fileType;
    this.fileSize = fileSize;
    this.totalChunks = chunks;
    this.receivedChunks = new Array(chunks).fill(null);
    this.startTime = Date.now();
    this.state = TransferState.WAITING;
    this.senderId = senderId;
    this.retryCount = 0;
    this.lastProgress = 0;
    this.paused = false;
    this.cancelled = false;
  }

  updateProgress(chunkIndex, data) {
    this.receivedChunks[chunkIndex] = data;
    const progress = this.getProgress();
    
    // 只在进度变化超过1%时更新UI
    if (progress - this.lastProgress >= 1) {
      this.lastProgress = progress;
      this.updateUI();
    }
    
    return progress === 100;
  }

  getProgress() {
    const receivedCount = this.receivedChunks.filter(chunk => chunk !== null).length;
    return Math.round((receivedCount / this.totalChunks) * 100);
  }

  updateUI() {
    const speed = this.calculateSpeed();
    updateProgressBar(this.fileId, this.getProgress(), this.senderId === socket.id ? 'upload' : 'download', speed);
  }

  calculateSpeed() {
    const now = Date.now();
    const lastTime = lastTransferTime.get(this.fileId) || this.startTime;
    const timeDiff = now - lastTime;
    
    if (timeDiff > 0) {
      const receivedSize = this.receivedChunks.reduce((acc, chunk) => acc + (chunk ? chunk.length : 0), 0);
      const speed = receivedSize / (timeDiff / 1000);
      transferSpeeds.set(this.fileId, speed);
      lastTransferTime.set(this.fileId, now);
      return speed;
    }
    return 0;
  }

  pause() {
    this.paused = true;
    this.state = TransferState.PAUSED;
  }

  resume() {
    this.paused = false;
    this.state = TransferState.TRANSFERRING;
  }

  cancel() {
    this.cancelled = true;
    this.state = TransferState.CANCELLED;
    this.cleanup();
  }

  cleanup() {
    transferSpeeds.delete(this.fileId);
    lastTransferTime.delete(this.fileId);
    transferBuffers.delete(this.fileId);
  }
}

export function handleFileTransfer(message, senderId) {
  try {
    const { fileId, fileName, fileType, fileSize, chunks } = message;
    
    if (fileSize > FILE_CONFIG.maxFileSize) {
      throw new Error(`文件大小超过限制 (${FILE_CONFIG.maxFileSize / 1024 / 1024}MB)`);
    }

    if (ongoingTransfers.size >= FILE_CONFIG.maxConcurrentTransfers) {
      throw new Error('当前传输任务数已达上限，请稍后再试');
    }

    const transfer = new FileTransfer(fileId, fileName, fileType, fileSize, chunks, senderId);
    ongoingTransfers.set(fileId, transfer);
    
    displayMessage(message, 'file');
  } catch (error) {
    showError(`处理文件传输请求失败: ${error.message}`);
  }
}

export function handleFileChunk(message, senderId) {
  try {
    const { fileId, chunkIndex, data, totalChunks } = message;
    const transfer = ongoingTransfers.get(fileId);
    
    if (!transfer) {
      throw new Error(`未找到文件传输记录: ${fileId}`);
    }

    if (transfer.paused || transfer.cancelled) {
      return;
    }

    const isComplete = transfer.updateProgress(chunkIndex, data);
    
    if (isComplete) {
      completeFileTransfer(fileId);
    }
  } catch (error) {
    showError(`处理文件块失败: ${error.message}`);
  }
}

export async function handleFileAccept(message, senderId) {
  try {
    const { fileId } = message;
    const transfer = ongoingTransfers.get(fileId);
    
    if (!transfer) {
      throw new Error(`未找到文件传输记录: ${fileId}`);
    }

    const connection = peerConnections.get(senderId);
    if (!connection?.dataChannel || connection.dataChannel.readyState !== 'open') {
      throw new Error(`与 ${senderId} 的连接不可用`);
    }

    transfer.state = TransferState.TRANSFERRING;
    await sendFileChunks(transfer.file, fileId, senderId);
  } catch (error) {
    showError(`发送文件失败: ${error.message}`);
  }
}

export function sendFile() {
  try {
    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];
    
    if (!file) {
      throw new Error('没有选择文件');
    }

    if (file.size > FILE_CONFIG.maxFileSize) {
      throw new Error(`文件大小超过限制 (${FILE_CONFIG.maxFileSize / 1024 / 1024}MB)`);
    }

    if (!hasActiveConnections()) {
      throw new Error('没有可用的连接，无法发送文件');
    }

    const fileId = generateFileId();
    const chunks = Math.ceil(file.size / FILE_CONFIG.chunkSize);
    
    const transfer = new FileTransfer(fileId, file.name, file.type, file.size, chunks, socket.id);
    transfer.file = file;
    transfer.pendingPeers = new Set();
    transfer.acceptedPeers = new Set();
    
    ongoingTransfers.set(fileId, transfer);

    broadcastFileInfo(transfer);
    displayMessage({
      fileId,
      fileName: file.name,
      fileSize: file.size,
      senderId: socket.id
    }, 'file');
  } catch (error) {
    showError(error.message);
  }
}

function generateFileId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function broadcastFileInfo(transfer) {
  const fileInfo = {
    type: 'file',
    fileId: transfer.fileId,
    fileName: transfer.fileName,
    fileType: transfer.fileType,
    fileSize: transfer.fileSize,
    chunks: transfer.totalChunks,
    senderId: socket.id
  };

  peerConnections.forEach(({ dataChannel }, peerId) => {
    if (dataChannel && dataChannel.readyState === 'open') {
      try {
        dataChannel.send(JSON.stringify(fileInfo));
        transfer.pendingPeers.add(peerId);
      } catch (error) {
        console.error(`向 ${peerId} 发送文件请求失败:`, error);
      }
    }
  });
}

async function sendFileChunks(file, fileId, peerId) {
  const transfer = ongoingTransfers.get(fileId);
  const connection = peerConnections.get(peerId);
  
  if (!connection?.dataChannel || connection.dataChannel.readyState !== 'open') {
    throw new Error('数据通道未就绪');
  }

  const { dataChannel } = connection;
  const chunkSize = FILE_CONFIG.chunkSize;
  const totalChunks = Math.ceil(file.size / chunkSize);
  let offset = 0;

  // 设置数据通道参数
  dataChannel.bufferedAmountLowThreshold = chunkSize * 2;
  
  for (let i = 0; i < totalChunks && !transfer.cancelled; i++) {
    if (transfer.paused) {
      await new Promise(resolve => {
        const checkPaused = () => {
          if (!transfer.paused) {
            resolve();
          } else {
            setTimeout(checkPaused, 100);
          }
        };
        checkPaused();
      });
    }

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
    transfer.updateProgress(i, arrayBuffer);
  }
}

async function sendWithBackPressure(channel, data) {
  return new Promise((resolve, reject) => {
    try {
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
    } catch (error) {
      reject(error);
    }
  });
}

export function completeFileTransfer(fileId) {
  try {
    const transfer = ongoingTransfers.get(fileId);
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

    transfer.state = TransferState.COMPLETED;
    transfer.cleanup();
    ongoingTransfers.delete(fileId);

    displayMessage(`系统: 文件 ${transfer.fileName} 传输完成`, 'system');
  } catch (error) {
    showError(`完成文件传输失败: ${error.message}`);
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

export function acceptFileTransfer(fileId, senderId) {
  try {
    const transfer = ongoingTransfers.get(fileId);
    if (!transfer) {
      throw new Error(`未找到文件传输记录: ${fileId}`);
    }

    const connection = peerConnections.get(senderId);
    if (!connection?.dataChannel || connection.dataChannel.readyState !== 'open') {
      throw new Error(`与 ${senderId} 的连接不可用`);
    }

    connection.dataChannel.send(JSON.stringify({
      type: 'file-accept',
      fileId
    }));

    transfer.state = TransferState.PREPARING;
  } catch (error) {
    showError(`接受文件传输失败: ${error.message}`);
  }
}

// 导出用于暂停/恢复/取消传输的函数
export function pauseTransfer(fileId) {
  const transfer = ongoingTransfers.get(fileId);
  if (transfer) {
    transfer.pause();
  }
}

export function resumeTransfer(fileId) {
  const transfer = ongoingTransfers.get(fileId);
  if (transfer) {
    transfer.resume();
  }
}

export function cancelTransfer(fileId) {
  const transfer = ongoingTransfers.get(fileId);
  if (transfer) {
    transfer.cancel();
  }
} 