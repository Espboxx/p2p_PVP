// 生成随机用户ID
const userId = Math.random().toString(36).substring(2, 8);
console.log(`生成的用户ID: ${userId}`); // 调试日志
const socket = io({ query: { userId } });

let currentRoom = null;
let peerConnections = new Map(); // key: socketId, value: { pc: RTCPeerConnection, dataChannel: RTCDataChannel, currentTransfer: { fileId, chunkIndex } }
const onlineUsers = new Map(); // 改为Map存储用户信息
const fileChunkSize = 16 * 1024; // 16KB分块

// WebRTC配置
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ]
};

// 添加一个存储文件传输状态的映射
const fileTransferStatus = new Map(); // key: fileId, value: Set of peerIds who have accepted

// 添加文件传输状态常量
const TransferState = {
  WAITING: 'waiting',    // 等待接收方确认
  TRANSFERRING: 'transferring', // 正在传输
  PAUSED: 'paused',     // 传输暂停（断开时）
  COMPLETED: 'completed', // 传输完成
  FAILED: 'failed'      // 传输失败
};

// 添加传输速度计算相关的变量
const transferSpeeds = new Map(); // key: fileId, value: { lastBytes: number, lastTime: number }

// 添加或更新进度条的函数
function updateProgressBar(fileId, progress, type = 'download', speed = 0) {
  const progressBarId = `progress-${fileId}`;
  let progressBar = document.getElementById(progressBarId);
  
  if (!progressBar) {
    // 创建进度条容器
    const container = document.createElement('div');
    container.className = 'progress-container';
    container.id = `progress-container-${fileId}`;
    
    // 创建进度条
    progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progressBar.id = progressBarId;
    
    // 创建进度文本
    const progressText = document.createElement('div');
    progressText.className = 'progress-text';
    progressText.id = `progress-text-${fileId}`;
    
    // 创建速度显示
    const speedText = document.createElement('div');
    speedText.className = 'speed-text';
    speedText.id = `speed-${fileId}`;
    
    container.appendChild(progressBar);
    container.appendChild(progressText);
    container.appendChild(speedText);
    
    // 将进度条添加到文件消息下方
    const fileMessage = document.getElementById(`file-${fileId}`);
    if (fileMessage) {
      fileMessage.appendChild(container);
    }
  }
  
  // 更新进度条
  progressBar.style.width = `${progress}%`;
  
  // 更新进度文本
  const progressText = document.getElementById(`progress-text-${fileId}`);
  if (progressText) {
    progressText.textContent = `${type === 'download' ? '下载' : '上传'}进度: ${progress}%`;
  }
  
  // 更新速度显示
  const speedText = document.getElementById(`speed-${fileId}`);
  if (speedText) {
    speedText.textContent = `${formatSpeed(speed)}/s`;
  }
}

// 格式化速度显示
function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond < 1024) {
    return `${bytesPerSecond.toFixed(1)} B`;
  } else if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB`;
  } else {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB`;
  }
}

// 计算传输速度
function calculateSpeed(fileId, bytes, isUpload = false) {
  const now = Date.now();
  const speedInfo = transferSpeeds.get(fileId) || { lastBytes: 0, lastTime: now };
  
  const timeDiff = now - speedInfo.lastTime;
  if (timeDiff >= 1000) { // 每秒更新一次速度
    const bytesDiff = bytes - speedInfo.lastBytes;
    const speed = (bytesDiff / timeDiff) * 1000; // 转换为字节/秒
    
    transferSpeeds.set(fileId, { lastBytes: bytes, lastTime: now });
    return speed;
  }
  return null;
}

// 更新用户列表
function updateUserList(users) {
  const userList = document.getElementById('userList');
  userList.innerHTML = '';
  
  users.forEach(user => {
    const li = document.createElement('li');
    // 只显示用户ID，不显示socket ID
    li.textContent = user.userId;
    userList.appendChild(li);
  });
}

// 添加一个函数来检查是否有活跃的连接
function hasActiveConnections() {
  let hasActive = false;
  peerConnections.forEach(({ dataChannel }) => {
    if (dataChannel && dataChannel.readyState === 'open') {
      hasActive = true;
    }
  });
  return hasActive;
}

// 修改 updateUIState 函数
function updateUIState() {
  const hasConnections = hasActiveConnections();
  const sendBtn = document.getElementById('sendBtn');
  const sendFileBtn = document.getElementById('sendFileBtn');
  const messageInput = document.getElementById('messageInput');
  const fileInput = document.getElementById('fileInput');
  
  // 只有在有其他用户时才禁用输入框
  if (peerConnections.size === 0) {
    // 没有其他用户时，允许发送消息到房间
    sendBtn.disabled = false;
    sendFileBtn.disabled = false;
    messageInput.disabled = false;
    fileInput.disabled = false;
    messageInput.placeholder = '输入消息';
  } else {
    // 有其他用户时，根据连接状态决定是否禁用
    sendBtn.disabled = !hasConnections;
    sendFileBtn.disabled = !hasConnections;
    messageInput.disabled = !hasConnections;
    fileInput.disabled = !hasConnections;
    
    if (!hasConnections) {
      messageInput.placeholder = '正在建立连接...';
    } else {
      messageInput.placeholder = '输入消息';
    }
  }
}

// 加入房间
function joinRoom() {
  const roomInput = document.getElementById('roomId').value.trim();
  if (!roomInput) {
    return alert('请输入房间号');
  }
  
  const statusDiv = document.getElementById('connectionStatus');
  statusDiv.textContent = '正在连接房间...';
  statusDiv.style.color = '#666';

  currentRoom = roomInput;
  socket.emit('join-room', currentRoom);
  
  // 禁用输入和按钮
  document.getElementById('roomId').disabled = true;
  document.getElementById('joinBtn').disabled = true;
  
  // 初始化聊天区域的UI状态
  document.getElementById('chatSection').classList.remove('hidden');
  updateUIState();
}

// 处理房间加入成功
socket.on('room-joined', ({ roomId, members }) => {
  console.log(`成功加入房间 ${roomId}，成员列表:`, members); // 调试日志
  const statusDiv = document.getElementById('connectionStatus');
  statusDiv.textContent = `✓ 已加入房间 ${roomId} (用户ID: ${userId})`;
  statusDiv.style.color = 'green';
  
  document.getElementById('chatSection').classList.remove('hidden');
  displayMessage(`系统: 成功加入房间 ${roomId}`, 'system');
  displayMessage(`系统: 当前在线成员 ${members.length}人`, 'system');
  
  // 自动连接现有成员
  members.forEach(({ id }) => {
    if (id !== socket.id && !peerConnections.has(id)) {
      createPeerConnection(id);
    }
  });
});

// 处理用户列表更新
socket.on('room-users-updated', (members) => {
  console.log('收到用户列表更新:', members); // 调试日志
  
  // 更新本地用户列表
  onlineUsers.clear();
  members.forEach(member => {
    onlineUsers.set(member.id, member.userId);
    console.log(`在线用户: ${member.userId} (${member.id})`); // 调试日志
  });
  
  // 更新显示
  updateUserList(members);
});

// 修改 user-connected 处理函数，移除用户列表更新逻辑
socket.on('user-connected', async ({ id, userId }) => {
  console.log(`新用户 ${userId} (${id}) 加入`);
  if (!peerConnections.has(id)) {
    const pc = await createPeerConnection(id);
    console.log(`已创建与 ${id} 的对等连接`);
  }
  displayMessage(`系统: 用户 ${userId} 已加入房间`, 'system');
});

// 修改 user-disconnected 处理函数
socket.on('user-disconnected', (id) => {
  const disconnectedUserId = onlineUsers.get(id);
  if (disconnectedUserId) {
    console.log(`用户断开: ${disconnectedUserId} (${id})`);
    displayMessage(`系统: 用户 ${disconnectedUserId} 已离开`, 'system');
    
    if (peerConnections.has(id)) {
      const { pc } = peerConnections.get(id);
      pc.close();
      peerConnections.delete(id);
      console.log(`已关闭与 ${id} 的对等连接`);
      // 更新UI状态
      updateUIState();
    }
  }
});

// 初始化事件监听
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('joinBtn').addEventListener('click', joinRoom);
  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('sendFileBtn').addEventListener('click', sendFile);
  
  // 初始化UI状态
  updateUIState();
});

// 初始化WebRTC连接
async function createPeerConnection(targetId) {
  const pc = new RTCPeerConnection(rtcConfig);
  
  // 创建并存储连接信息
  const connection = { pc, dataChannel: null, currentTransfer: null };
  peerConnections.set(targetId, connection);
  
  const dataChannel = pc.createDataChannel('chatChannel');
  
  setupDataChannel(dataChannel, targetId);
  connection.dataChannel = dataChannel;
  
  // 添加 ondatachannel 事件监听
  pc.ondatachannel = (event) => {
    const receiveChannel = event.channel;
    console.log(`收到来自 ${targetId} 的数据通道`);
    setupDataChannel(receiveChannel, targetId);
    // 更新接收通道
    const conn = peerConnections.get(targetId);
    if (conn) {
      conn.dataChannel = receiveChannel;
      console.log(`接收的数据通道已绑定到 ${targetId}`);
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

  // 添加协商需要事件处理
  pc.onnegotiationneeded = async () => {
    try {
      // 创建并设置本地描述
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(`发送 offer 给 ${targetId}`);
      
      // 发送 offer 给对方
      socket.emit('signal', {
        to: targetId,
        signal: { type: 'offer', offer }
      });
    } catch (err) {
      console.error('创建 offer 失败:', err);
    }
  };

  // 监听连接状态变化
  pc.onconnectionstatechange = () => {
    console.log(`连接状态 (${targetId}):`, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      peerConnections.delete(targetId);
      console.log(`已移除与 ${targetId} 的对等连接`);
      displayMessage(`系统: 与 ${onlineUsers.get(targetId) || '未知用户'} 的连接已关闭`, 'system');
    }
  };

  return pc;
}

// 修改 setupDataChannel 函数
function setupDataChannel(channel, targetId) {
  channel.onopen = () => {
    console.log(`与 ${targetId} 的数据通道已打开`);
    
    // 检查是否有暂停的传输需要恢复
    Object.entries(ongoingTransfers).forEach(([fileId, transfer]) => {
      if (transfer.state === TransferState.PAUSED) {
        if (transfer.senderId === socket.id) {
          // 如果是发送方，重新发送未完成的块
          resumeFileTransfer(fileId, targetId);
        } else if (transfer.senderId === targetId) {
          // 如果是接收方，请求重新发送未完成的块
          requestResendChunks(fileId, targetId);
        }
      }
    });
    
    updateUIState();
  };

  channel.onmessage = async ({ data }) => {
    console.log(`从 ${targetId} 收到的数据:`, data); // 新增日志
    const connection = peerConnections.get(targetId);
    if (!connection) {
      console.log(`无效的连接: ${targetId}`);
      return;
    }

    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        console.log(`解析后的消息类型: ${message.type}`); // 新增日志
        if (message.type === 'text') {
          const senderName = onlineUsers.get(targetId) || '未知用户';
          console.log(`显示消息: ${senderName}: ${message.text}`); // 新增日志
          displayMessage(`${senderName}: ${message.text}`, 'text');
        } else if (message.type === 'file') {
          handleFileTransfer(message, targetId);
        } else if (message.type === 'chunk') {
          handleFileChunk(message, targetId);
        } else if (message.type === 'file-accept') {
          handleFileAccept(message, targetId);
        } else {
          console.log('未知的消息类型:', message.type);
        }
      } catch (e) {
        console.log('消息处理错误:', e);
      }
    } else {
      // 处理二进制数据（如文件块）
      if (connection.currentTransfer) {
        const { fileId, chunkIndex } = connection.currentTransfer;
        const transfer = ongoingTransfers[fileId];
        if (transfer) {
          // 记录已接收的块
          transfer.receivedChunksMap.set(chunkIndex, data);
          transfer.receivedChunks += 1;
          
          console.log(`收到文件块 ${transfer.receivedChunks}/${transfer.chunks} for fileId=${fileId}`);
          
          // 检查是否所有块都已接收
          if (transfer.receivedChunks === transfer.chunks) {
            // 按顺序重组文件
            transfer.fileBuffer = Array.from({ length: transfer.chunks }, (_, i) => 
              transfer.receivedChunksMap.get(i)
            );
            completeFileTransfer(fileId);
          }
        } else {
          console.log(`未找到传输信息: fileId=${fileId}`);
        }
        connection.currentTransfer = null;
      } else {
        console.log('收到意外的二进制数据，未关联到任何传输');
      }
    }
  };

  channel.onerror = (error) => {
    console.error(`与 ${targetId} 的数据通道错误:`, error);
  };

  channel.onclose = () => {
    console.log(`与 ${targetId} 的数据通道已关闭`);
    
    // 检查是否有正在进行的传输
    Object.entries(ongoingTransfers).forEach(([fileId, transfer]) => {
      if (transfer.state === TransferState.TRANSFERRING) {
        transfer.state = TransferState.PAUSED;
        displayMessage(`系统: 文件 "${transfer.fileName}" 传输已暂停，等待重新连接...`, 'system');
      }
    });
    
    updateUIState();
  };
}

// 处理文件块数据
function handleFileChunk(message, targetId) {
  const { fileId, chunkIndex } = message;
  const transfer = ongoingTransfers[fileId];
  if (!transfer) return;

  try {
    transfer.state = TransferState.TRANSFERRING;
    
    const connection = peerConnections.get(targetId);
    if (connection) {
      connection.currentTransfer = { fileId, chunkIndex };
      
      // 计算进度
      const progress = Math.round(((transfer.receivedChunks + 1) / transfer.chunks) * 100);
      
      // 计算速度
      const bytesReceived = (transfer.receivedChunks + 1) * fileChunkSize;
      const speed = calculateSpeed(fileId, bytesReceived);
      
      // 更新进度条
      if (speed !== null) {
        updateProgressBar(fileId, progress, 'download', speed);
      } else {
        updateProgressBar(fileId, progress, 'download');
      }
    }
  } catch (error) {
    console.error('处理文件块失败:', error);
  }
}

// 完成文件传输
function completeFileTransfer(fileId) {
  const transfer = ongoingTransfers[fileId];
  const blob = new Blob(transfer.fileBuffer, { type: transfer.fileType });
  const url = URL.createObjectURL(blob);

  // 验证文件哈希
  generateFileHash(blob).then((receivedHash) => {
    if (receivedHash === transfer.hash) {
      console.log(`文件 "${transfer.fileName}" 完整性验证通过`);
      
      // 创建下载链接并自动触发下载
      const a = document.createElement('a');
      a.href = url;
      a.download = transfer.fileName;
      a.style.display = 'none'; // 隐藏链接
      document.body.appendChild(a);
      a.click(); // 自动触发下载
      document.body.removeChild(a); // 移除链接
      URL.revokeObjectURL(url); // 释放URL对象

      // 显示下载成功消息
      displayMessage(`系统: 文件 "${transfer.fileName}" (${formatSize(transfer.fileSize)}) 下载完成`, 'system');

      // 清理传输状态
      ongoingTransfers[fileId] = null;
      fileTransferStatus.delete(fileId);
    } else {
      console.error(`文件 "${transfer.fileName}" 的哈希不匹配，传输可能已损坏`);
      displayMessage(`系统: 文件 "${transfer.fileName}" 传输失败（哈希不匹配）`, 'system');
      ongoingTransfers[fileId] = null;
      fileTransferStatus.delete(fileId);
    }
  }).catch(err => {
    console.error('文件哈希生成失败:', err);
    displayMessage(`系统: 文件 "${transfer.fileName}" 哈希验证失败`, 'system');
  });
}

// 文件传输处理
function handleFileTransfer(message, senderId) {
  const { fileId, fileName, fileType, fileSize, hash, chunks } = message;
  console.log(`处理来自 ${senderId} 的文件传输请求: `, message);
  
  if (!ongoingTransfers[fileId]) {
    ongoingTransfers[fileId] = {
      fileName,
      fileType,
      fileSize,
      hash,
      chunks,
      receivedChunks: 0,
      fileBuffer: [],
      state: TransferState.WAITING,
      receivedChunksMap: new Map(), // 记录已接收的块
      senderId // 记录发送者ID
    };
    
    displayMessage({ 
      fileId, 
      fileName, 
      fileType, 
      fileSize, 
      hash,
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

const ongoingTransfers = {}; // 添加：存储进行中的文件传输

// 接收文件的处理函数
function acceptFile(fileId, senderId) {
  // 发送接收确认给发送端
  const acceptMessage = {
    type: 'file-accept',
    fileId
  };
  const connection = peerConnections.get(senderId);
  if (connection && connection.dataChannel && connection.dataChannel.readyState === 'open') {
    connection.dataChannel.send(JSON.stringify(acceptMessage));
    console.log(`已向 ${senderId} 发送文件接收确认（fileId: ${fileId}）`);
    // 更新传输状态
    if (fileTransferStatus.has(fileId)) {
      fileTransferStatus.get(fileId).add(senderId);
    }
    // 更新UI
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
  }
}

// 接收文件接收确认
function handleFileAccept(message, senderId) {
  console.log(`收到来自 ${senderId} 的文件接收确认: `, message);
  const { fileId } = message;
  const transfer = ongoingTransfers[fileId];
  
  if (transfer) {
    // 将peer从等待列表移到已接受列表
    transfer.pendingPeers.delete(senderId);
    transfer.acceptedPeers.add(senderId);
    
    // 开始向该 peer 发送文件
    sendFileChunks(fileId, senderId);

    // 更新发送状态显示
    const totalPeers = transfer.acceptedPeers.size + transfer.pendingPeers.size;
    const acceptedPeers = transfer.acceptedPeers.size;
    displayMessage(`系统: 文件 "${transfer.fileName}" 已被 ${acceptedPeers}/${totalPeers} 个用户接受`, 'system');
  }
}

// 修改 sendFileChunks 函数，添加上传进度显示
async function sendFileChunks(fileId, peerId) {
  console.log(`开始发送文件块: fileId=${fileId} to peerId=${peerId}`);
  const transfer = ongoingTransfers[fileId];
  if (!transfer) {
    console.log(`传输信息不存在: fileId=${fileId}`);
    return;
  }

  const connection = peerConnections.get(peerId);
  if (!connection || !connection.dataChannel || connection.dataChannel.readyState !== 'open') {
    console.log(`无法向 ${peerId} 发送文件块，数据通道未打开`);
    return;
  }

  const file = transfer.file;
  const reader = new FileReader();
  reader.onload = async () => {
    const buffer = reader.result;
    let i = 0;
    
    // 创建发送函数
    const sendNextChunk = async () => {
      if (i >= transfer.chunks) {
        console.log(`文件 "${transfer.fileName}" 已发送完毕给 ${peerId}`);
        return;
      }

      // 检查数据通道的缓冲区状态
      if (connection.dataChannel.bufferedAmount > 1024 * 1024) { // 1MB 缓冲区限制
        // 如果缓冲区已满，等待一段时间后重试
        console.log(`数据通道缓冲区已满，等待发送... bufferedAmount: ${connection.dataChannel.bufferedAmount}`);
        setTimeout(sendNextChunk, 100);
        return;
      }

      const chunk = buffer.slice(
        i * fileChunkSize,
        (i + 1) * fileChunkSize
      );

      const chunkInfo = {
        type: 'chunk',
        fileId,
        chunkIndex: i
      };

      try {
        // 发送数据块
        connection.dataChannel.send(JSON.stringify(chunkInfo));
        connection.dataChannel.send(chunk);
        
        // 计算进度
        const progress = Math.round(((i + 1) / transfer.chunks) * 100);
        
        // 计算速度
        const bytesSent = (i + 1) * fileChunkSize;
        const speed = calculateSpeed(fileId, bytesSent, true);
        
        // 更新进度条
        if (speed !== null) {
          updateProgressBar(fileId, progress, 'upload', speed);
        } else {
          updateProgressBar(fileId, progress, 'upload');
        }

        i++;
        requestAnimationFrame(sendNextChunk);
      } catch (error) {
        console.error(`发送文件块失败:`, error);
        setTimeout(() => sendNextChunk(), 1000);
      }
    };

    // 开始发送第一个块
    sendNextChunk();
  };

  reader.onerror = (error) => {
    console.error('读取文件失败:', error);
    displayMessage(`系统: 读取文件 "${transfer.fileName}" 失败`, 'system');
  };

  try {
    reader.readAsArrayBuffer(file);
  } catch (error) {
    console.error('启动文件读取失败:', error);
    displayMessage(`系统: 无法读取文件 "${transfer.fileName}"`, 'system');
  }
}

// 修改 sendFile 函数，添加广播支持
async function sendFile() {
  // 如果没有其他用户，显示提示
  if (peerConnections.size === 0) {
    displayMessage('系统: 当前房间中只有您一人，无法发送文件', 'system');
    return;
  }

  // 如果有其他用户但没有活跃连接
  if (!hasActiveConnections()) {
    displayMessage('系统: 正在建立连接，请稍后重试', 'system');
    return;
  }

  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];
  if (!file) {
    alert('请先选择要发送的文件');
    return;
  }

  displayMessage(`系统: 准备发送文件 "${file.name}"...`, 'system');
  
  // 生成文件哈希
  const hash = await generateFileHash(file);
  
  const fileId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  
  const fileInfo = {
    type: 'file',
    fileId,
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
    hash,
    chunks: Math.ceil(file.size / fileChunkSize),
    senderId: socket.id
  };

  // 存储文件信息
  ongoingTransfers[fileId] = {
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
    hash,
    chunks: fileInfo.chunks,
    receivedChunks: 0,
    fileBuffer: [],
    file,
    acceptedPeers: new Set(), // 记录已接受的peer
    pendingPeers: new Set(),   // 记录等待接受的peer
    state: TransferState.WAITING,
    receivedChunksMap: new Map(), // 记录已接收的块
    senderId: socket.id
  };

  // 记录所有在线的peer
  peerConnections.forEach((_, peerId) => {
    ongoingTransfers[fileId].pendingPeers.add(peerId);
  });

  // 发送文件信息给所有 peer
  peerConnections.forEach(({ dataChannel }, peerId) => {
    if (dataChannel && dataChannel.readyState === 'open') {
      console.log(`发送文件信息给 ${peerId}:`, fileInfo);
      dataChannel.send(JSON.stringify(fileInfo));
    }
  });

  // 清空文件输入
  fileInput.value = '';
}

// 生成文件的 SHA-256 哈希值
async function generateFileHash(file) {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

// 显示消息
function displayMessage(message, type = 'text') {
  const messagesDiv = document.getElementById('messages');
  const messageElement = document.createElement('div');
  messageElement.classList.add('message');
  
  if (type === 'file') {
    messageElement.id = `file-${message.fileId}`;
    const senderName = message.senderId === socket.id ? '我' : 
                      (onlineUsers.get(message.senderId) || '未知用户');
    messageElement.innerHTML = `${senderName} 发送文件: "${message.fileName}" (${formatSize(message.fileSize)})`;
  } else if (type === 'system') {
    messageElement.textContent = message;
    messageElement.classList.add('system');
  } else if (type === 'text') {
    messageElement.textContent = message;
  }
  
  messagesDiv.appendChild(messageElement);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// 格式化文件大小
function formatSize(bytes) {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
}

// 信令处理
socket.on('signal', async ({ from, signal }) => {
  if (!peerConnections.has(from)) {
    const pc = await createPeerConnection(from);
    console.log(`创建新的对等连接：${from}`);
  }

  const connection = peerConnections.get(from);
  const pc = connection.pc;
  
  try {
    if (signal.type === 'offer') {
      console.log('收到 offer');
      await pc.setRemoteDescription(signal.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log('发送 answer');
      socket.emit('signal', { 
        to: from, 
        signal: { type: 'answer', answer } 
      });
    } else if (signal.type === 'answer') {
      console.log('收到 answer');
      await pc.setRemoteDescription(signal.answer);
    } else if (signal.type === 'candidate') {
      console.log('收到 ICE candidate');
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  } catch (err) {
    console.error('信令处理错误:', err);
  }
});

// 修改 sendMessage 函数
function sendMessage() {
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
        dataChannel.send(JSON.stringify({ type: 'text', text: message }));
      }
    });
    displayMessage(`我: ${message}`, 'text');
    input.value = '';
  }
}

// 添加恢复传输的函数
function resumeFileTransfer(fileId, targetId) {
  const transfer = ongoingTransfers[fileId];
  if (!transfer || transfer.state !== TransferState.PAUSED) return;

  displayMessage(`系统: 正在恢复文件 "${transfer.fileName}" 的传输...`, 'system');
  transfer.state = TransferState.TRANSFERRING;
  
  // 重新发送文件信息
  const connection = peerConnections.get(targetId);
  if (connection && connection.dataChannel && connection.dataChannel.readyState === 'open') {
    sendFileChunks(fileId, targetId);
  }
}

// 添加请求重新发送的函数
function requestResendChunks(fileId, targetId) {
  const transfer = ongoingTransfers[fileId];
  if (!transfer || transfer.state !== TransferState.PAUSED) return;

  // 计算缺失的块
  const missingChunks = [];
  for (let i = 0; i < transfer.chunks; i++) {
    if (!transfer.receivedChunksMap.has(i)) {
      missingChunks.push(i);
    }
  }

  // 发送重传请求
  const connection = peerConnections.get(targetId);
  if (connection && connection.dataChannel && connection.dataChannel.readyState === 'open') {
    connection.dataChannel.send(JSON.stringify({
      type: 'resend-request',
      fileId,
      chunks: missingChunks
    }));
    
    displayMessage(`系统: 请求重新发送文件 "${transfer.fileName}" 的缺失部分...`, 'system');
  }
}

// 添加处理重传请求的函数
function handleResendRequest(message, targetId) {
  const { fileId, chunks } = message;
  const transfer = ongoingTransfers[fileId];
  
  if (transfer && transfer.file) {
    displayMessage(`系统: 正在重新发送文件 "${transfer.fileName}" 的缺失部分...`, 'system');
    sendSpecificChunks(fileId, targetId, chunks);
  }
}

// 添加发送特定块的函数
async function sendSpecificChunks(fileId, peerId, chunkIndices) {
  const transfer = ongoingTransfers[fileId];
  if (!transfer || !transfer.file) return;

  const connection = peerConnections.get(peerId);
  if (!connection || !connection.dataChannel || connection.dataChannel.readyState !== 'open') return;

  const reader = new FileReader();
  reader.onload = () => {
    const buffer = reader.result;
    chunkIndices.forEach(i => {
      const chunk = buffer.slice(
        i * fileChunkSize,
        (i + 1) * fileChunkSize
      );

      const chunkInfo = {
        type: 'chunk',
        fileId,
        chunkIndex: i
      };

      connection.dataChannel.send(JSON.stringify(chunkInfo));
      connection.dataChannel.send(chunk);
    });
  };
  reader.readAsArrayBuffer(transfer.file);
}
