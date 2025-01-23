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
      receivedChunks: 0,
      fileBuffer: new Array(chunks),
      state: TransferState.WAITING,
      receivedChunksMap: new Map(),
      senderId,
      startTime: Date.now(),
      pendingChunk: null
    };
    
    displayMessage({ 
      fileId, 
      fileName, 
      fileType, 
      fileSize,
      senderId
    }, 'file');

    const fileMessage = document.getElementById(`file-${fileId}`);
    if (fileMessage) {
      const receiveBtn = document.createElement('button');
      receiveBtn.textContent = '接收';
      receiveBtn.style.marginLeft = '10px';
      receiveBtn.onclick = () => acceptFile(fileId, senderId);
      fileMessage.appendChild(receiveBtn);
    }
  }
}

export function handleFileChunk(message, senderId) {
  const { fileId, chunkIndex, size } = message;
  const transfer = ongoingTransfers[fileId];
  if (!transfer) {
    console.log(`未找到文件传输记录: ${fileId}`);
    return;
  }

  try {
    transfer.state = TransferState.TRANSFERRING;
    
    // 等待接收实际的二进制数据
    transfer.pendingChunk = {
      index: chunkIndex,
      size: size
    };
    
  } catch (error) {
    console.error('处理文件块元数据失败:', error);
    transfer.state = TransferState.FAILED;
    displayMessage(`系统: 接收文件 "${transfer.fileName}" 失败`, 'system');
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

        // 存储数据
        transfer.fileBuffer[index] = new Uint8Array(chunk);
        transfer.receivedChunks++;
        transfer.receivedChunksMap.set(index, true);
        
        // 计算速度
        const now = Date.now();
        const timeDiff = now - transfer.startTime;
        if (timeDiff > 0) {
          const bytesReceived = transfer.receivedChunks * size;
          const speed = Math.round(bytesReceived / (timeDiff / 1000));
          transferSpeeds.set(fileId, speed);
        }

        // 更新进度
        const progress = Math.round((transfer.receivedChunks / transfer.chunks) * 100);
        updateProgressBar(fileId, progress, 'download', transferSpeeds.get(fileId) || 0);

        // 清除待处理标记
        transfer.pendingChunk = null;

        // 检查是否完成
        if (transfer.receivedChunks === transfer.chunks) {
          completeFileTransfer(fileId);
        }
      } catch (error) {
        console.error('处理文件块数据失败:', error);
        transfer.state = TransferState.FAILED;
        displayMessage(`系统: 接收文件 "${transfer.fileName}" 失败: ${error.message}`, 'system');
      }
      break;
    }
  }
}

export function handleFileAccept(message, senderId) {
  const { fileId } = message;
  const transfer = ongoingTransfers[fileId];
  if (!transfer) return;

  console.log(`${senderId} 接受了文件 ${fileId}`);
  transfer.state = TransferState.TRANSFERRING;
  sendFileChunks(fileId, senderId);
}

export function sendFile() {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];
  if (!file) {
    alert('请选择要发送的文件');
    return;
  }

  // 检查是否有活跃连接
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
    pendingPeers: new Set(), // 添加待接收的用户集合
    acceptedPeers: new Set() // 添加已接受的用户集合
  };

  let sentCount = 0;
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
        senderId: socket.id  // 添加发送者ID
      };
      try {
        dataChannel.send(JSON.stringify(fileInfo));
        ongoingTransfers[fileId].pendingPeers.add(peerId);
        sentCount++;
        console.log(`已向 ${peerId} 发送文件传输请求`);
      } catch (error) {
        console.error(`向 ${peerId} 发送文件请求失败:`, error);
      }
    }
  });

  if (sentCount > 0) {
    displayMessage(`系统: 正在等待用户接收文件 "${file.name}"...`, 'system');
  } else {
    displayMessage('系统: 没有可用的连接，无法发送文件', 'system');
    delete ongoingTransfers[fileId];
  }
}

function sendFileChunks(fileId, targetId) {
  const transfer = ongoingTransfers[fileId];
  if (!transfer || !transfer.file) return;

  const connection = peerConnections.get(targetId);
  if (!connection || !connection.dataChannel) return;

  const reader = new FileReader();
  reader.onload = () => {
    const buffer = reader.result;
    let offset = 0;
    let chunkIndex = 0;
    let lastSendTime = Date.now();
    const SEND_INTERVAL = 0; // 1ms 间隔发送，避免过快
    const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB 缓冲区限制

    function sendNextChunk() {
      try {
        // 检查是否完成
        if (offset >= buffer.byteLength) {
          console.log(`文件 ${fileId} 发送完成`);
          return;
        }

        // 检查数据通道状态
        if (!connection.dataChannel || connection.dataChannel.readyState !== 'open') {
          console.error('数据通道已关闭');
          transfer.state = TransferState.FAILED;
          displayMessage(`系统: 发送文件 "${transfer.fileName}" 失败：连接已断开`, 'system');
          return;
        }

        // 检查缓冲区
        if (connection.dataChannel.bufferedAmount > MAX_BUFFER_SIZE) {
          setTimeout(sendNextChunk, 100);
          return;
        }

        const now = Date.now();
        const timeSinceLastSend = now - lastSendTime;
        
        if (timeSinceLastSend >= SEND_INTERVAL) {
          const chunk = buffer.slice(offset, offset + fileChunkSize);
          
          // 发送元数据
          connection.dataChannel.send(JSON.stringify({
            type: 'chunk',
            fileId,
            chunkIndex,
            size: chunk.byteLength
          }));
          
          // 发送数据
          connection.dataChannel.send(chunk);

          offset += chunk.byteLength;
          chunkIndex++;
          lastSendTime = now;

          // 更新进度
          const progress = Math.round((offset / buffer.byteLength) * 100);
          const speed = calculateTransferSpeed(fileId, offset);
          updateProgressBar(fileId, progress, 'upload', speed);
        }

        // 使用 setTimeout 代替 requestAnimationFrame
        setTimeout(sendNextChunk, SEND_INTERVAL);
      } catch (error) {
        console.error('发送文件块失败:', error);
        // 发生错误时延迟重试
        setTimeout(sendNextChunk, 1000);
      }
    }

    // 开始发送
    console.log(`开始发送文件 ${fileId}, 总大小: ${buffer.byteLength} 字节`);
    transfer.state = TransferState.TRANSFERRING;
    sendNextChunk();
  };

  reader.onerror = (error) => {
    console.error('读取文件失败:', error);
    transfer.state = TransferState.FAILED;
    displayMessage(`系统: 读取文件 "${transfer.fileName}" 失败`, 'system');
  };

  try {
    reader.readAsArrayBuffer(transfer.file);
  } catch (error) {
    console.error('启动文件读取失败:', error);
    transfer.state = TransferState.FAILED;
    displayMessage(`系统: 无法读取文件 "${transfer.fileName}"`, 'system');
  }
}

function completeFileTransfer(fileId) {
  const transfer = ongoingTransfers[fileId];
  if (!transfer) return;

  try {
    // 合并所有文件块
    const chunks = transfer.fileBuffer.filter(chunk => chunk);
    if (chunks.length !== transfer.chunks) {
      throw new Error('文件块不完整');
    }

    // 计算总大小并创建最终的 ArrayBuffer
    const totalSize = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
    const finalBuffer = new Uint8Array(totalSize);
    
    // 按顺序复制所有块
    let offset = 0;
    chunks.forEach(chunk => {
      finalBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    });

    // 创建 Blob 对象
    const blob = new Blob([finalBuffer], { type: transfer.fileType });
    const url = URL.createObjectURL(blob);
    
    // 创建下载链接函数
    const createDownloadLink = () => {
      const downloadLink = document.createElement('a');
      downloadLink.href = url;
      downloadLink.download = transfer.fileName;
      downloadLink.textContent = '下载文件';
      downloadLink.className = 'download-button';
      
      downloadLink.onclick = (e) => {
        e.preventDefault();
        try {
          const tempLink = document.createElement('a');
          tempLink.style.display = 'none';
          tempLink.href = url;
          tempLink.download = transfer.fileName;
          document.body.appendChild(tempLink);
          tempLink.click();
          document.body.removeChild(tempLink);
          
          displayMessage(`系统: 开始下载文件 "${transfer.fileName}"`, 'system');
          
          // 创建新的下载链接
          const fileMessage = document.getElementById(`file-${fileId}`);
          if (fileMessage) {
            const oldButton = fileMessage.querySelector('.download-button');
            if (oldButton) {
              fileMessage.removeChild(oldButton);
            }
            fileMessage.appendChild(createDownloadLink());
          }
        } catch (error) {
          console.error('下载文件失败:', error);
          displayMessage(`系统: 下载文件失败，请重试`, 'system');
        }
      };
      
      return downloadLink;
    };

    // 添加初始下载链接
    const fileMessage = document.getElementById(`file-${fileId}`);
    if (fileMessage) {
      const oldButton = fileMessage.querySelector('.download-button');
      if (oldButton) {
        fileMessage.removeChild(oldButton);
      }
      fileMessage.appendChild(createDownloadLink());
    }

    transfer.state = TransferState.COMPLETED;
    displayMessage(`系统: 文件 "${transfer.fileName}" 接收完成`, 'system');
    
    // 保存 blob URL 到传输对象中，以便后续使用
    transfer.blobUrl = url;
    
    // 清理内存
    transfer.fileBuffer = null;
  } catch (error) {
    console.error('处理文件完成时出错:', error);
    displayMessage(`系统: 处理文件失败: ${error.message}`, 'system');
  }
}

function calculateTransferSpeed(fileId, bytesTransferred) {
  const transfer = ongoingTransfers[fileId];
  if (!transfer) return 0;

  const now = Date.now();
  const duration = (now - transfer.startTime) / 1000; // 转换为秒
  return bytesTransferred / duration; // bytes per second
}

async function generateFileHash(file) {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

function calculateSpeed(fileId, bytes, isUpload = false) {
  const now = Date.now();
  const speedInfo = transferSpeeds.get(fileId) || { lastBytes: 0, lastTime: now };
  
  const timeDiff = now - speedInfo.lastTime;
  if (timeDiff >= 1000) {
    const bytesDiff = bytes - speedInfo.lastBytes;
    const speed = (bytesDiff / timeDiff) * 1000;
    
    transferSpeeds.set(fileId, { lastBytes: bytes, lastTime: now });
    return speed;
  }
  return null;
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

export function acceptFile(fileId, senderId) {
  const acceptMessage = {
    type: 'file-accept',
    fileId
  };
  
  const connection = peerConnections.get(senderId);
  if (connection && connection.dataChannel && connection.dataChannel.readyState === 'open') {
    connection.dataChannel.send(JSON.stringify(acceptMessage));
    console.log(`已向 ${senderId} 发送文件接收确认（fileId: ${fileId}）`);
    
    if (fileTransferStatus.has(fileId)) {
      fileTransferStatus.get(fileId).add(senderId);
    } else {
      fileTransferStatus.set(fileId, new Set([senderId]));
    }
    
    const fileMessage = document.getElementById(`file-${fileId}`);
    if (fileMessage) {
      const btn = fileMessage.querySelector('button');
      if (btn) {
        fileMessage.removeChild(btn);
      }
      displayMessage(`系统: 已接受文件 "${ongoingTransfers[fileId].fileName}"`, 'system');
    }
  } else {
    console.log(`无法发送接收确认给 ${senderId}，数据通道未打开`);
    displayMessage('系统: 连接已断开，无法接收文件', 'system');
  }
}

// ... 其他文件传输相关函数 ... 