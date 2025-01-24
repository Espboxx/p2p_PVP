import { peerConnections } from './webrtc.js';
import { socket } from './socket.js';
import { onlineUsers } from './socket.js';
import { formatSize, formatSpeed } from './utils.js';
import { reconnect } from './webrtc.js';
import { sendFile } from './fileTransfer.js';
import { fileChunkSize, TransferState } from './config.js';
import { ongoingTransfers } from './fileTransfer.js';

let sidebarCollapsed = false;

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const toggleButton = document.getElementById('sidebarToggle');
  
  sidebarCollapsed = !sidebarCollapsed;
  
  sidebar.classList.toggle('collapsed');
  toggleButton.classList.toggle('collapsed');
  toggleButton.textContent = sidebarCollapsed ? '⟩' : '⟨';
  
}

document.addEventListener('DOMContentLoaded', () => {
  const toggleButton = document.getElementById('sidebarToggle');
  const overlay = document.getElementById('sidebarOverlay');
  
  if (toggleButton) {
    toggleButton.addEventListener('click', toggleSidebar);
  }
  
  // 点击遮罩层收起侧边栏
  if (overlay) {
    overlay.addEventListener('click', () => {
      if (!sidebarCollapsed) {
        toggleSidebar();
      }
    });
  }
  
  // 监听窗口大小变化
  window.addEventListener('resize', () => {
    const overlay = document.getElementById('sidebarOverlay');
    if (window.innerWidth > 868) {
      overlay.classList.remove('active');
    }
  });

  // 添加拖拽相关事件监听
  const dragOverlay = document.getElementById('dragOverlay');
  const chatArea = document.querySelector('.chat-area');

  // 防止浏览器默认行为
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
  });

  // 文件拖入聊天区域
  chatArea.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (hasActiveConnections()) {
      dragOverlay.classList.add('active');
    }
  });

  // 文件在覆盖层上拖动
  dragOverlay.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  // 文件离开覆盖层
  dragOverlay.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (e.target === dragOverlay) {
      dragOverlay.classList.remove('active');
    }
  });

  // 处理文件放下事件
  dragOverlay.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragOverlay.classList.remove('active');

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      // 如果有多个文件，逐个发送
      for (const file of files) {
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
          pendingPeers: new Set(),
          acceptedPeers: new Set()
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
              senderId: socket.id
            };
            try {
              dataChannel.send(JSON.stringify(fileInfo));
              ongoingTransfers[fileId].pendingPeers.add(peerId);
              sentCount++;
            } catch (error) {
              console.error(`向 ${peerId} 发送文件请求失败:`, error);
            }
          }
        });

        if (sentCount > 0) {
          displayMessage({
            fileId,
            fileName: file.name,
            fileSize: file.size,
            senderId: socket.id
          }, 'file');
        } else {
          displayMessage('系统: 没有可用的连接，无法发送文件', 'system');
        }
      }
    }
  });
});

export function updateUIState() {
  const hasConnections = hasActiveConnections();
  const isConnecting = hasConnectingPeers();
  
  const sendBtn = document.getElementById('sendBtn');
  const sendFileBtn = document.getElementById('sendFileBtn');
  const messageInput = document.getElementById('messageInput');
  const fileInput = document.getElementById('fileInput');
  
  if (peerConnections.size === 0) {
    // 没有其他用户
    sendBtn.disabled = false;
    sendFileBtn.disabled = false;
    messageInput.disabled = false;
    fileInput.disabled = false;
    messageInput.placeholder = '输入消息';
  } else if (isConnecting) {
    // 正在建立连接
    sendBtn.disabled = true;
    sendFileBtn.disabled = true;
    messageInput.disabled = true;
    fileInput.disabled = true;
    messageInput.placeholder = '正在建立连接...';
  } else {
    // 有其他用户且已建立连接
    sendBtn.disabled = !hasConnections;
    sendFileBtn.disabled = !hasConnections;
    messageInput.disabled = !hasConnections;
    fileInput.disabled = !hasConnections;
    messageInput.placeholder = hasConnections ? '输入消息' : '连接已断开';
  }
}

export function displayMessage(message, type = 'text') {
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

export function updateProgressBar(fileId, progress, type = 'download', speed = 0) {
  const progressBarId = `progress-${fileId}`;
  let progressBar = document.getElementById(progressBarId);
  
  if (!progressBar) {
    const container = document.createElement('div');
    container.className = 'progress-container';
    container.id = `progress-container-${fileId}`;
    
    progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progressBar.id = progressBarId;
    
    const progressText = document.createElement('div');
    progressText.className = 'progress-text';
    progressText.id = `progress-text-${fileId}`;
    
    const speedText = document.createElement('div');
    speedText.className = 'speed-text';
    speedText.id = `speed-${fileId}`;
    
    container.appendChild(progressBar);
    container.appendChild(progressText);
    container.appendChild(speedText);
    
    const fileMessage = document.getElementById(`file-${fileId}`);
    if (fileMessage) {
      fileMessage.appendChild(container);
    }
  }
  
  progressBar.style.width = `${progress}%`;
  
  const progressText = document.getElementById(`progress-text-${fileId}`);
  if (progressText) {
    progressText.textContent = `${type === 'download' ? '下载' : '上传'}进度: ${progress}%`;
  }
  
  const speedText = document.getElementById(`speed-${fileId}`);
  if (speedText && speed > 0) {
    let speedDisplay;
    if (speed < 1024) {
      speedDisplay = `${speed.toFixed(1)} B/s`;
    } else if (speed < 1024 * 1024) {
      speedDisplay = `${(speed / 1024).toFixed(1)} KB/s`;
    } else {
      speedDisplay = `${(speed / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    speedText.textContent = speedDisplay;
  }
}

export function updateUserList(users) {
  const userList = document.getElementById('userList');
  const sidebarTitle = document.querySelector('.sidebar h3');
  userList.innerHTML = '';
  
  users.forEach(user => {
    const li = document.createElement('li');
    li.textContent = user.userId;
    userList.appendChild(li);
  });

  sidebarTitle.textContent = `在线用户 (${users.length})`;
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

function hasConnectingPeers() {
  let hasConnecting = false;
  peerConnections.forEach(({ pc }) => {
    if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
      hasConnecting = true;
    }
  });
  return hasConnecting;
}

export function showReconnectButton(targetId) {
  const reconnectContainer = document.createElement('div');
  reconnectContainer.className = 'reconnect-container';
  reconnectContainer.id = `reconnect-${targetId}`;
  
  const reconnectBtn = document.createElement('button');
  reconnectBtn.textContent = `重新连接 ${onlineUsers.get(targetId) || '未知用户'}`;
  reconnectBtn.onclick = () => {
    reconnect(targetId);
    reconnectContainer.remove();
  };
  
  reconnectContainer.appendChild(reconnectBtn);
  
  const messagesDiv = document.getElementById('messages');
  messagesDiv.appendChild(reconnectContainer);
}

// ... 其他 UI 相关函数 ... 