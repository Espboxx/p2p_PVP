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
    
    // 创建文件传输消息
    const messageElement = document.createElement('div');
    messageElement.className = 'message';
    messageElement.id = `file-message-${fileId}`;
    
    messageElement.innerHTML = `
      <div class="file-message">
        <div class="file-info-section">
          <div class="file-icon">
            <svg viewBox="0 0 24 24">
              <path fill="currentColor" d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" />
            </svg>
          </div>
          <div class="file-details">
            <div class="file-name">${fileName}</div>
            <div class="file-meta">${formatFileSize(fileSize)}</div>
          </div>
        </div>
        <div class="progress-container">
          <div class="progress-wrapper">
            <div class="progress-bar" style="width: 0%"></div>
          </div>
          <div class="status-container">
            <div class="progress-text">准备接收...</div>
            <div class="speed-text"></div>
          </div>
        </div>
      </div>
    `;

    // 添加到消息区域
    const messagesDiv = document.getElementById('messages');
    messagesDiv.appendChild(messageElement);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  } catch (error) {
    showError(`处理文件传输请求失败: ${error.message}`);
  }
}

// 添加文件大小格式化函数
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

export function handleFileChunk(message, senderId) {
  const { fileId, chunkIndex, data, totalChunks } = message;
  
  // 获取或初始化传输记录
  let transfer = ongoingTransfers.get(fileId);
  if (!transfer) {
    console.error('未找到文件传输记录:', fileId);
    return;
  }

  // 更新接收进度
  transfer.receivedChunks[chunkIndex] = data;
  const receivedCount = transfer.receivedChunks.filter(chunk => chunk !== null).length;
  const progress = Math.round((receivedCount / totalChunks) * 100);

  // 更新UI
  const messageElement = document.getElementById(`file-message-${fileId}`);
  if (messageElement) {
    const progressBar = messageElement.querySelector('.progress-bar');
    const progressText = messageElement.querySelector('.progress-text');
    const speedText = messageElement.querySelector('.speed-text');
    
    if (progressBar) {
      progressBar.style.width = `${progress}%`;
    }
    if (progressText) {
      progressText.textContent = `接收中... ${progress}%`;
    }
    
    // 计算传输速度
    const now = Date.now();
    const timeDiff = now - (transfer.lastUpdateTime || transfer.startTime);
    if (timeDiff > 1000) {
      const receivedBytes = transfer.receivedChunks.reduce((acc, chunk) => acc + (chunk ? chunk.length : 0), 0);
      const speed = (receivedBytes / 1024 / 1024) / (timeDiff / 1000); // MB/s
      if (speedText) {
        speedText.textContent = `${speed.toFixed(1)} MB/s`;
      }
      transfer.lastUpdateTime = now;
    }
  }

  // 检查是否接收完成
  if (receivedCount === totalChunks) {
    completeFileTransfer(fileId);
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

    // 更新发送方UI状态
    const messageElement = document.getElementById(`file-message-${fileId}`);
    if (messageElement) {
      const progressText = messageElement.querySelector('.progress-text');
      if (progressText) {
        progressText.textContent = '开始发送...';
      }
    }

    transfer.state = TransferState.TRANSFERRING;
    transfer.acceptedPeers.add(senderId);
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
    const chunkSize = FILE_CONFIG.chunkSize;
    const totalChunks = Math.ceil(file.size / chunkSize);

    // 创建文件传输消息
    const messageElement = document.createElement('div');
    messageElement.className = 'message self';
    messageElement.id = `file-message-${fileId}`;
    
    messageElement.innerHTML = `
      <div class="file-message">
        <div class="file-info-section">
          <div class="file-icon">
            <svg viewBox="0 0 24 24">
              <path fill="currentColor" d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" />
            </svg>
          </div>
          <div class="file-details">
            <div class="file-name">${file.name}</div>
            <div class="file-meta">${formatFileSize(file.size)}</div>
          </div>
        </div>
        <div class="progress-container">
          <div class="progress-wrapper">
            <div class="progress-bar" style="width: 0%"></div>
          </div>
          <div class="status-container">
            <div class="progress-text">准备发送...</div>
            <div class="speed-text"></div>
          </div>
        </div>
      </div>
    `;

    // 添加到消息区域
    const messagesDiv = document.getElementById('messages');
    messagesDiv.appendChild(messageElement);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    // 计算总连接数
    const totalConnections = Array.from(peerConnections.values()).filter(
      ({dataChannel}) => dataChannel?.readyState === 'open'
    ).length;
    
    let completedConnections = 0;

    // 通过 data channel 发送给所有连接的用户
    peerConnections.forEach(async ({ dataChannel }, peerId) => {
      if (dataChannel && dataChannel.readyState === 'open') {
        try {
          // 设置缓冲区阈值
          dataChannel.bufferedAmountLowThreshold = 65535; // 64KB

          // 先发送文件信息
          const fileInfo = {
            type: 'file',
            fileId,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            chunks: totalChunks,
            senderId: socket.id
          };
          
          await sendWithBackPressure(dataChannel, JSON.stringify(fileInfo));
          
          let sentChunks = 0;
          let lastSpeedUpdate = Date.now();
          let bytesTransferred = 0;
          
          const updateProgress = () => {
            const progress = Math.round((sentChunks / totalChunks) * 100);
            const progressBar = messageElement.querySelector('.progress-bar');
            const progressText = messageElement.querySelector('.progress-text');
            const speedText = messageElement.querySelector('.speed-text');
            
            if (progressBar) {
              progressBar.style.width = `${progress}%`;
            }
            if (progressText) {
              progressText.textContent = `发送中... ${progress}%`;
            }

            // 更新传输速度
            const now = Date.now();
            const timeDiff = now - lastSpeedUpdate;
            if (timeDiff >= 1000) {
              const speed = (bytesTransferred / 1024 / 1024) / (timeDiff / 1000); // MB/s
              if (speedText) {
                speedText.textContent = `${speed.toFixed(1)} MB/s`;
              }
              lastSpeedUpdate = now;
              bytesTransferred = 0;
            }
          };

          // 分块读取并发送文件
          for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const chunk = file.slice(start, end);
            
            // 读取文件块
            const arrayBuffer = await chunk.arrayBuffer();
            const chunkData = Array.from(new Uint8Array(arrayBuffer));
            bytesTransferred += arrayBuffer.byteLength;
            
            const chunkMessage = {
              type: 'file-chunk',
              fileId,
              chunkIndex: i,
              totalChunks,
              data: chunkData
            };
            
            // 使用背压控制发送数据
            await sendWithBackPressure(dataChannel, JSON.stringify(chunkMessage));
            sentChunks++;
            updateProgress();
          }

          completedConnections++;
          
          // 所有连接都发送完成
          if (completedConnections === totalConnections) {
            const progressContainer = messageElement.querySelector('.progress-container');
            const progressText = messageElement.querySelector('.progress-text');
            if (progressContainer) {
              progressContainer.classList.add('completed');
            }
            if (progressText) {
              progressText.textContent = '发送完成';
            }
          }
        } catch (error) {
          console.error(`向 ${peerId} 发送文件失败:`, error);
          const progressText = messageElement.querySelector('.progress-text');
          if (progressText) {
            progressText.textContent = '发送失败';
            progressText.style.color = 'var(--danger-color)';
          }
        }
      }
    });
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
  let lastUpdateTime = Date.now();
  let bytesTransferred = 0;

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
    bytesTransferred += arrayBuffer.byteLength;

    // 计算进度和速度
    const currentTime = Date.now();
    const timeDiff = currentTime - lastUpdateTime;
    const progress = Math.round((i + 1) / totalChunks * 100);

    // 每100ms更新一次进度和速度
    if (timeDiff >= 100) {
      const speed = bytesTransferred / (timeDiff / 1000); // 字节/秒
      updateProgressBar(fileId, progress, 'upload', speed);
      lastUpdateTime = currentTime;
      bytesTransferred = 0;
    }
  }

  // 确保最后更新到100%
  if (!transfer.cancelled) {
    updateProgressBar(fileId, 100, 'upload', 0);
  }
}

// 发送数据时检查缓冲区
async function sendWithBackPressure(dataChannel, data) {
  return new Promise((resolve, reject) => {
    try {
      // 如果缓冲区快满了，等待缓冲区清空
      if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
        const onBufferLow = () => {
          dataChannel.removeEventListener('bufferedamountlow', onBufferLow);
          dataChannel.send(data);
          resolve();
        };
        dataChannel.addEventListener('bufferedamountlow', onBufferLow);
      } else {
        dataChannel.send(data);
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

    // 检查所有数据块是否都已接收
    if (transfer.receivedChunks.some(chunk => chunk === null)) {
      console.error('文件数据不完整');
      showError('文件数据不完整，传输失败');
      return;
    }

    // 将数据块转换为 Uint8Array 数组
    const chunks = transfer.receivedChunks.map(chunk => {
      if (Array.isArray(chunk)) {
        return new Uint8Array(chunk);
      }
      return new Uint8Array(chunk);
    });

    // 创建 Blob
    const blob = new Blob(chunks, {
      type: transfer.fileType || 'application/octet-stream'
    });

    // 更新现有的文件消息元素
    const messageElement = document.getElementById(`file-message-${fileId}`);
    if (messageElement) {
      const progressContainer = messageElement.querySelector('.progress-container');
      const fileMessage = messageElement.querySelector('.file-message');
      const progressText = messageElement.querySelector('.progress-text');
      
      if (progressContainer && fileMessage) {
        // 更新进度条状态
        progressContainer.classList.add('completed');
        const progressBar = progressContainer.querySelector('.progress-bar');
        if (progressBar) {
          progressBar.style.width = '100%';
        }
        
        // 更新进度文本
        if (progressText) {
          progressText.textContent = '传输完成';
          progressText.classList.add('completed');
        }

        // 移除现有的下载按钮（如果存在）
        const existingDownloadInfo = fileMessage.querySelector('.file-download-info');
        if (existingDownloadInfo) {
          existingDownloadInfo.remove();
        }

        // 添加下载按钮
        const downloadInfo = document.createElement('div');
        downloadInfo.className = 'file-download-info';
        downloadInfo.innerHTML = `<button class="download-btn">保存文件</button>`;
        fileMessage.appendChild(downloadInfo);

        // 添加下载按钮点击事件
        const downloadBtn = downloadInfo.querySelector('.download-btn');
        downloadBtn.onclick = () => {
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
            downloadBtn.textContent = '已下载';
            downloadBtn.disabled = true;
          }, 100);
        };
      }
    }

    transfer.state = TransferState.COMPLETED;
    transfer.cleanup();
    ongoingTransfers.delete(fileId);

    displayMessage(`系统: 文件 ${transfer.fileName} 传输完成`, 'system');
  } catch (error) {
    console.error('完成文件传输失败:', error);
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