import { fileChunkSize, TransferState } from './config.js';
import { peerConnections } from './webrtc.js';
import { socket } from './socket.js';
import { displayMessage, updateProgressBar } from './ui.js';
import { cryptoHelper } from './crypto.js';

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
      receivedChunks: 0,
      fileBuffer: new Array(chunks),
      state: TransferState.WAITING,
      receivedChunksMap: new Map(),
      senderId,
      startTime: Date.now()
    };
    
    // 显示文件消息
    displayMessage({ 
      fileId, 
      fileName, 
      fileType, 
      fileSize,
      chunks,
      senderId,
      showProgress: true
    }, 'file');
  }
}

export function handleFileChunk(message, senderId) {
  const { fileId, chunkIndex, data, totalChunks } = message;
  
  const transfer = ongoingTransfers[fileId];
  if (!transfer) {
    console.error(`未找到文件传输记录: ${fileId}`);
    return;
  }

  try {
    // 如果还没有设置总块数，现在设置它
    if (!transfer.chunks && totalChunks) {
      transfer.chunks = totalChunks;
    }

    transfer.fileBuffer[chunkIndex] = new Uint8Array(data);
    transfer.receivedChunks++;
    transfer.receivedChunksMap.set(chunkIndex, true);
    
    // 计算传输速度（每秒更新一次）
    const now = Date.now();
    const speedInfo = transferSpeeds.get(fileId) || { speed: 0, lastBytes: 0, lastTime: now };
    const timeDiff = now - speedInfo.lastTime;
    
    // 累计接收到的字节数
    const currentBytes = transfer.receivedChunks * data.length;
    
    // 每秒更新一次速度
    if (timeDiff >= 1000) {
      const bytesDiff = currentBytes - speedInfo.lastBytes;
      const speed = Math.round(bytesDiff / (timeDiff / 1000));
      
      transferSpeeds.set(fileId, {
        speed,
        lastBytes: currentBytes,
        lastTime: now
      });
    }
    
    // 确保我们有总块数再计算进度
    if (transfer.chunks) {
      const progress = Math.round((transfer.receivedChunks / transfer.chunks) * 100);
      const fileMessage = document.getElementById(`file-${fileId}`);
      if (fileMessage) {
        const fileContainer = fileMessage.querySelector('.file-message');
        if (fileContainer) {
          const progressContainer = fileContainer.querySelector('.progress-container');
          if (progressContainer) {
            const progressBar = progressContainer.querySelector('.progress-bar');
            const progressText = progressContainer.querySelector('.progress-text');
            const speedText = progressContainer.querySelector('.transfer-speed');
            
            if (progressBar) {
              progressBar.style.width = `${progress}%`;
            }
            
            if (progressText) {
              progressText.textContent = `${progress}%`;
            }
            
            // 更新速度显示
            if (speedText) {
              const speedInfo = transferSpeeds.get(fileId);
              if (speedInfo && speedInfo.speed > 0) {
                speedText.textContent = `${formatSpeed(speedInfo.speed)}/s`;
              }
            }
            
            // 当进度达到100%时
            if (progress === 100) {
              progressText.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24">
                  <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
                </svg>
                下载完成
              `;
              progressContainer.classList.add('completed');
              
              // 完成后延迟一小段时间再调用 completeFileTransfer，确保UI更新完成
              setTimeout(() => {
                if (transfer.state !== TransferState.COMPLETED) {
                  completeFileTransfer(fileId);
                }
              }, 100);
            }
          }
        }
      }
    }
    
    // 检查是否完成
    if (transfer.chunks && transfer.receivedChunks === transfer.chunks && 
        transfer.state !== TransferState.COMPLETED) {
      transfer.state = TransferState.COMPLETED;
      completeFileTransfer(fileId);
    }
  } catch (error) {
    console.error('处理文件块失败:', error);
    transfer.state = TransferState.FAILED;
    displayMessage(`系统: 接收文件 "${transfer.fileName}" 失败: ${error.message}`, 'system');
  }
}

export function handleChunkData(chunk, senderId) {
  // 遍历所有传输找到待处理的块
  for (const [fileId, transfer] of Object.entries(ongoingTransfers)) {
    if (transfer.pendingChunk && transfer.senderId === senderId) {
      try {
        const { index, size } = transfer.pendingChunk;
        
        // 验证数据大小
        if (chunk.byteLength !== size) {
          throw new Error(`数据大小不匹配: 预期 ${size}, 实际 ${chunk.byteLength}`);
        }

        // 调用主要的处理函数，包含总块数信息
        handleFileChunk({
          fileId,
          chunkIndex: index,
          data: chunk,
          totalChunks: transfer.chunks // 添加总块数信息
        }, senderId);

        // 清除待处理标记
        transfer.pendingChunk = null;
      } catch (error) {
        console.error('处理文件块数据失败:', error);
        transfer.state = TransferState.FAILED;
        displayMessage(`系统: 接收文件 "${transfer.fileName}" 失败: ${error.message}`, 'system');
      }
      break;
    }
  }
}

export async function handleFileAccept(message, senderId) {
  const { fileId } = message;
  const transfer = ongoingTransfers[fileId];
  if (!transfer) {
    console.log(`未找到文件传输记录: ${fileId}`);
    return;
  }

  console.log(`收到来自 ${senderId} 的文件接收确认，fileId: ${fileId}`);
  transfer.state = TransferState.TRANSFERRING;
  transfer.acceptedPeers = transfer.acceptedPeers || new Set();
  transfer.acceptedPeers.add(senderId);

  // 移除外部进度条（如果存在）
  const outsideProgressBar = document.querySelector(`.progress-container[data-file-id="${fileId}"]`);
  if (outsideProgressBar && !outsideProgressBar.closest('.file-message')) {
    outsideProgressBar.remove();
  }
  
  // 更新UI显示
  const fileMessage = document.getElementById(`file-${fileId}`);
  if (fileMessage) {
    const fileContainer = fileMessage.querySelector('.file-message');
    if (fileContainer) {
      // 移除下载按钮
      const downloadButton = fileContainer.querySelector('.download-button');
      if (downloadButton) {
        downloadButton.remove();
      }

      // 确保只有一个进度条
      let progressContainer = fileContainer.querySelector('.progress-container');
      if (!progressContainer) {
        progressContainer = document.createElement('div');
        progressContainer.className = 'progress-container';
        progressContainer.setAttribute('data-file-id', fileId);
        progressContainer.innerHTML = `
          <div class="progress-wrapper">
            <div class="progress-bar" style="width: 0%"></div>
          </div>
          <div class="progress-text">0%</div>
          <div class="transfer-speed"></div>
        `;
        fileContainer.appendChild(progressContainer);
      }
      progressContainer.style.display = 'block';
    }
  }

  // 开始发送文件块
  if (transfer.file) {
    try {
      console.log(`开始向 ${senderId} 发送文件 ${fileId}`);
      await sendFileChunks(transfer.file, fileId, senderId);
    } catch (error) {
      console.error('发送文件失败:', error);
      transfer.state = TransferState.FAILED;
      displayMessage(`系统: 发送文件 "${transfer.fileName}" 失败: ${error.message}`, 'system');
    }
  }
}

// 辅助函数：读取文件块
function readFileChunk(chunk) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(chunk);
  });
}

export function sendFile() {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];
  
  if (!file) return;
  
  // 检查是否有活跃连接
  if (!hasActiveConnections()) {
    displayMessage('系统: 没有可用的连接，无法发送文件', 'system');
    return;
  }
  
  const fileId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const chunks = Math.ceil(file.size / fileChunkSize);
  
  // 创建传输记录
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
  
  let sentCount = 0;
  
  // 首先显示发送者的文件消息
  displayMessage({
    fileId,
    fileName: file.name,
    fileSize: file.size,
    senderId: socket.id
  }, 'file');
  
  // 向所有连接的用户发送加密的文件传输请求
  peerConnections.forEach((connection, peerId) => {
    if (connection.dataChannel?.readyState === 'open' && connection.sendEncryptedMessage) {
      try {
        connection.sendEncryptedMessage({
          type: 'file',
          fileId,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          chunks,
          senderId: socket.id
        }).catch(error => {
          console.error(`向 ${peerId} 发送文件请求失败:`, error);
        });
        ongoingTransfers[fileId].pendingPeers.add(peerId);
        sentCount++;
      } catch (error) {
        console.error(`准备发送文件到 ${peerId} 失败:`, error);
      }
    }
  });
  
  if (sentCount === 0) {
    displayMessage('系统: 没有可用的连接，无法发送文件', 'system');
    delete ongoingTransfers[fileId];
  }
  
  // 重置文件输入框
  fileInput.value = '';
}

// 添加一个队列控制函数
async function sendWithBackPressure(channel, data) {
  return new Promise((resolve, reject) => {
    // 检查缓冲区大小
    if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
      // 如果缓冲区已满，等待缓冲区清空事件
      const onBufferLow = () => {
        channel.removeEventListener('bufferedamountlow', onBufferLow);
        try {
          channel.send(data);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      channel.addEventListener('bufferedamountlow', onBufferLow);
    } else {
      // 缓冲区未满，直接发送
      try {
        channel.send(data);
        resolve();
      } catch (error) {
        reject(error);
      }
    }
  });
}

// 修改 sendEncryptedMessage 函数
export async function sendEncryptedMessage(message, peerId) {
  const connection = peerConnections.get(peerId);
  if (connection?.dataChannel?.readyState === 'open') {
    try {
      const encrypted = await cryptoHelper.encrypt(message, peerId);
      const data = JSON.stringify({
        encrypted: Array.from(encrypted.encrypted),
        iv: Array.from(encrypted.iv)
      });
      
      // 使用流量控制发送数据
      await sendWithBackPressure(connection.dataChannel, data);
    } catch (error) {
      console.error('发送加密消息失败:', error);
      throw error;
    }
  }
}

// 修改 sendFileChunks 函数
async function sendFileChunks(file, fileId, peerId) {
  const transfer = ongoingTransfers[fileId];
  if (!transfer || !file) {
    console.error('找不到文件或传输记录');
    return;
  }

  const chunkSize = fileChunkSize;
  const totalChunks = Math.ceil(file.size / chunkSize);
  const maxConcurrent = 5; // 最大并行传输数
  
  console.log(`开始发送文件 ${fileId} 到 ${peerId}, 总块数: ${totalChunks}`);
  transfer.sentChunks = 0; // 初始化已发送块计数

  try {
    // 分批发送文件块
    for (let i = 0; i < totalChunks; i += maxConcurrent) {
      const chunkPromises = [];
      
      // 创建一批并行的传输任务
      for (let j = 0; j < maxConcurrent && (i + j) < totalChunks; j++) {
        const chunkIndex = i + j;
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        
        const chunkPromise = (async () => {
          const chunk = await readFileChunk(file.slice(start, end));
          await sendEncryptedChunk(chunk, fileId, chunkIndex, peerId);
          
          // 更新进度
          transfer.sentChunks++;
          const progress = Math.round((transfer.sentChunks / totalChunks) * 100);
          
          // 只更新文件消息内的进度条
          const fileMessage = document.getElementById(`file-${fileId}`);
          if (fileMessage) {
            const progressContainer = fileMessage.querySelector('.file-message .progress-container');
            if (progressContainer) {
              const progressBar = progressContainer.querySelector('.progress-bar');
              const progressText = progressContainer.querySelector('.progress-text');
              
              if (progressBar) {
                progressBar.style.width = `${progress}%`;
              }
              if (progressText) {
                progressText.textContent = `${progress}%`;
              }
              
              // 当进度达到100%时
              if (progress === 100) {
                progressText.innerHTML = `
                  <svg width="16" height="16" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
                  </svg>
                  发送完成
                `;
                progressContainer.classList.add('completed');
              }
            }
          }
        })();
        
        chunkPromises.push(chunkPromise);
      }
      
      // 等待当前批次的所有块发送完成
      await Promise.all(chunkPromises);
      
      // 检查数据通道的缓冲状态
      const connection = peerConnections.get(peerId);
      if (connection?.dataChannel?.bufferedAmount > 1024 * 1024) { // 1MB缓冲区阈值
        await new Promise(resolve => setTimeout(resolve, 50)); // 短暂暂停
      }
    }
    
    console.log(`文件 ${fileId} 发送完成`);
    transfer.state = TransferState.COMPLETED;
  } catch (error) {
    console.error(`发送文件块失败:`, error);
    transfer.state = TransferState.FAILED;
    displayMessage(`系统: 发送文件 "${transfer.fileName}" 失败`, 'system');
  }
}

// 修改 sendEncryptedChunk 函数，确保发送完整的块信息
async function sendEncryptedChunk(chunk, fileId, chunkIndex, peerId) {
  const connection = peerConnections.get(peerId);
  if (!connection?.dataChannel || connection.dataChannel.readyState !== 'open') {
    throw new Error('数据通道未打开');
  }

  const transfer = ongoingTransfers[fileId];
  if (!transfer) {
    throw new Error('找不到传输记录');
  }

  try {
    // 使用 TypedArray 直接处理数据，避免不必要的转换
    const chunkArray = new Uint8Array(chunk);
    
    // 发送文件块，包含更多信息
    await connection.sendEncryptedMessage({
      type: 'file-chunk',
      fileId,
      chunkIndex,
      totalChunks: transfer.chunks,
      data: Array.from(chunkArray)
    });
  } catch (error) {
    console.error(`发送文件块 ${chunkIndex} 失败:`, error);
    throw error;
  }
}

export function completeFileTransfer(fileId) {
  const transfer = ongoingTransfers[fileId];
  if (!transfer) return;

  try {
    const blob = new Blob(transfer.fileBuffer, { type: transfer.fileType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    // 创建下载链接
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = transfer.fileName;
    downloadLink.className = 'download-button';
    downloadLink.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
      </svg>
      保存文件
    `;

    // 更新UI显示
    const fileMessage = document.getElementById(`file-${fileId}`);
    if (fileMessage) {
      // 移除进度条
      const progressContainer = fileMessage.querySelector('.progress-container');
      if (progressContainer) {
        progressContainer.remove();
      }

      // 添加下载按钮
      const actionContainer = document.createElement('div');
      actionContainer.className = 'file-action-container';
      actionContainer.appendChild(downloadLink);
      fileMessage.appendChild(actionContainer);

      // 添加完成标记
      const statusBadge = document.createElement('div');
      statusBadge.className = 'file-status-badge completed';
      statusBadge.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
        </svg>
        已完成
      `;
      fileMessage.querySelector('.file-info-section').appendChild(statusBadge);
    }

    // 更新传输状态
    transfer.state = TransferState.COMPLETED;
    transfer.blobUrl = url;
    
    // 自动触发下载
    downloadLink.click();
    
    // 清理内存
    transfer.fileBuffer = null;
    
    displayMessage(`系统: 文件 "${transfer.fileName}" 下载完成`, 'system');
  } catch (error) {
    console.error('处理文件完成时出错:', error);
    displayMessage(`系统: 处理文件失败: ${error.message}`, 'system');
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
  console.log(`准备发送文件接收确认，fileId: ${fileId}, senderId: ${senderId}`);
  
  const connection = peerConnections.get(senderId);
  if (connection?.dataChannel?.readyState === 'open') {
    try {
      // 发送文件接收确认
      connection.sendEncryptedMessage({
        type: 'file-accept',
        fileId
      }).then(() => {
        // 更新UI显示
        const fileMessage = document.getElementById(`file-${fileId}`);
        if (fileMessage) {
          // 移除下载按钮
          const downloadButton = fileMessage.querySelector('.download-button');
          if (downloadButton) {
            downloadButton.remove();
          }
          
          // 显示进度条
          const progressContainer = fileMessage.querySelector('.progress-container');
          if (progressContainer) {
            progressContainer.style.display = 'block';
          }
        }
      });
    } catch (error) {
      console.error('发送文件接受确认失败:', error);
      displayMessage('系统: 连接已断开，无法接收文件', 'system');
    }
  }
}

// 修改 handleDecryptedMessage 函数，完善对文件块的处理
export function handleDecryptedMessage(decrypted, senderId) {
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
        totalChunks: decrypted.totalChunks // 添加总块数信息
      }, senderId);
      break;
    case 'file':
      handleFileTransfer(decrypted, senderId);
      break;
    case 'file-accept':
      handleFileAccept(decrypted, senderId);
      break;
    default:
      console.log('未知消息类型:', decrypted.type);
  }
}



// 修改 setupDataChannel 函数中的相关配置
export async function setupDataChannel(channel, targetId) {
  // 设置缓冲区阈值
  channel.bufferedAmountLowThreshold = 64 * 1024; // 64KB
  
  // ... 其他代码保持不变 ...
}

// 添加格式化速度的函数
function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond < 1024) {
    return `${bytesPerSecond} B`;
  } else if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB`;
  } else if (bytesPerSecond < 1024 * 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB`;
  } else {
    return `${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}

// ... 其他文件传输相关函数 ... 