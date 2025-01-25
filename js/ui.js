import { ConnectionState, connectionAttempts } from './connectionState.js';
import { peerConnections } from './webrtc.js';
import { socket, onlineUsers } from './socket.js';
import { formatSize, formatSpeed } from './utils.js';
import { reconnect } from './webrtc.js';
import { sendFile, acceptFileTransfer } from './fileTransfer.js';
import { fileChunkSize, TransferState } from './config.js';
import { ongoingTransfers } from './fileTransfer.js';

let sidebarCollapsed = false;

// 添加一个用于存储最近系统消息的变量
let lastSystemMessage = {
  text: '',
  element: null,
  count: 0,
  timer: null
};

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const toggleButton = document.getElementById('sidebarToggle');
  const sidebarWrapper = document.querySelector('.sidebar-wrapper');
  
  sidebarCollapsed = !sidebarCollapsed;
  
  sidebar.classList.toggle('collapsed');
  toggleButton.classList.toggle('collapsed');
  toggleButton.textContent = sidebarCollapsed ? '⟩' : '⟨';
  
  // 添加移动端遮罩层
  if (window.innerWidth <= 868) {
    const overlay = document.getElementById('sidebarOverlay');
    if (overlay) {
      overlay.classList.toggle('active', !sidebarCollapsed);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const toggleButton = document.getElementById('sidebarToggle');
  const sidebarWrapper = document.querySelector('.sidebar-wrapper');
  const messageInput = document.getElementById('messageInput');
  const mobileUsersToggle = document.getElementById('mobileUsersToggle');
  
  // 创建并添加遮罩层
  const sidebarOverlay = document.createElement('div');
  sidebarOverlay.className = 'sidebar-overlay';
  document.body.appendChild(sidebarOverlay);
  
  // 切换用户列表
  mobileUsersToggle?.addEventListener('click', () => {
    sidebarWrapper.classList.add('active');
    sidebarOverlay.classList.add('active');
  });
  
  // 点击遮罩层关闭用户列表
  sidebarOverlay.addEventListener('click', () => {
    sidebarWrapper.classList.remove('active');
    sidebarOverlay.classList.remove('active');
  });
  
  if (toggleButton) {
    toggleButton.addEventListener('click', toggleSidebar);
  }
  
  // 点击遮罩层收起侧边栏
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
      if (!sidebarCollapsed) {
        toggleSidebar();
      }
    });
  }
  
  // 监听窗口大小变化
  window.addEventListener('resize', () => {
    if (window.innerWidth > 868) {
      sidebarOverlay.classList.remove('active');
      sidebarWrapper.classList.remove('active');
    }
  });

  // 监听触摸滑动手势
  let touchStartX = 0;
  let touchEndX = 0;
  
  document.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
  });
  
  document.addEventListener('touchmove', (e) => {
    touchEndX = e.touches[0].clientX;
  });
  
  document.addEventListener('touchend', () => {
    const swipeDistance = touchEndX - touchStartX;
    
    // 从左向右滑动打开用户列表
    if (swipeDistance > 100 && touchStartX < 50) {
      sidebarWrapper.classList.add('active');
      sidebarOverlay.classList.add('active');
    }
    
    // 从右向左滑动关闭用户列表
    if (swipeDistance < -100 && sidebarWrapper.classList.contains('active')) {
      sidebarWrapper.classList.remove('active');
      sidebarOverlay.classList.remove('active');
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

  // 添加回车发送消息功能
  if (messageInput) {
    messageInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // 阻止默认的换行行为
        const sendBtn = document.getElementById('sendBtn');
        if (!sendBtn.disabled) {
          sendBtn.click();
        }
      }
    });
  }
});

export function updateUIState() {
  const hasConnections = hasActiveConnections();
  const isConnecting = hasConnectingPeers();
  const hasOtherUsers = peerConnections.size > 0;
  
  const sendBtn = document.getElementById('sendBtn');
  const messageInput = document.getElementById('messageInput');
  const fileUploadBtn = document.querySelector('.file-upload-btn');
  const fileInput = document.getElementById('fileInput');
  
  if (!hasOtherUsers) {
    // 没有其他用户
    sendBtn.disabled = true;
    messageInput.disabled = true;
    if (fileUploadBtn) {
      fileUploadBtn.style.pointerEvents = 'none';
      fileUploadBtn.style.opacity = '0.5';
    }
    fileInput.disabled = true;
    messageInput.placeholder = '等待其他用户加入...';
  } else if (isConnecting) {
    // 正在建立连接
    sendBtn.disabled = true;
    messageInput.disabled = true;
    if (fileUploadBtn) {
      fileUploadBtn.style.pointerEvents = 'none';
      fileUploadBtn.style.opacity = '0.5';
    }
    fileInput.disabled = true;
    messageInput.placeholder = '正在建立连接...';
  } else if (!hasConnections) {
    // 有其他用户但没有成功建立连接
    sendBtn.disabled = true;
    messageInput.disabled = true;
    if (fileUploadBtn) {
      fileUploadBtn.style.pointerEvents = 'none';
      fileUploadBtn.style.opacity = '0.5';
    }
    fileInput.disabled = true;
    messageInput.placeholder = '等待与其他用户建立连接...';
    displayMessage('系统: 正在等待与其他用户建立连接，请稍候...', 'system');
  } else {
    // 有其他用户且已建立连接
    sendBtn.disabled = false;
    messageInput.disabled = false;
    if (fileUploadBtn) {
      fileUploadBtn.style.pointerEvents = 'auto';
      fileUploadBtn.style.opacity = '1';
    }
    fileInput.disabled = false;
    messageInput.placeholder = '输入消息';
  }
}

// 修改系统消息过滤函数
function shouldShowSystemMessage(message) {
  // 定义重要的系统消息关键词
  const importantKeywords = [
    '连接失败',
    '断开连接',
    '文件传输',
    '错误',
    '等待其他用户',
    '正在建立连接',
    '连接成功',
    '加入了房间',
    '离开了房间',
    '已接受文件',
    '下载完成',
    '上传完成'
  ];
  
  // 检查消息是否包含重要关键词
  return importantKeywords.some(keyword => message.includes(keyword));
}

// 修改系统消息的显示时间
function updateSystemMessage(message, messageElement) {
  // 更新最近的系统消息
  lastSystemMessage = {
    text: message,
    element: messageElement,
    count: 1,
    timer: setTimeout(() => {
      // 5秒后淡出消息
      if (messageElement && messageElement.parentNode) {
        messageElement.style.animation = 'fadeOut 1s ease forwards';
        setTimeout(() => {
          messageElement.remove();
        }, 1000);
      }
      lastSystemMessage = { text: '', element: null, count: 0, timer: null };
    }, 5000)
  };
}

// 在 displayMessage 函数中修改文件消息的处理部分
export function displayMessage(message, type = 'text') {
  const messagesDiv = document.getElementById('messages');
  
  if (type === 'system') {
    // 只显示重要的系统消息
    if (!shouldShowSystemMessage(message)) {
      console.log('Skipped system message:', message);
      return;
    }
    
    // 检查是否与上一条系统消息相似
    if (isSimularMessage(message, lastSystemMessage.text)) {
      if (lastSystemMessage.timer) {
        clearTimeout(lastSystemMessage.timer);
      }
      
      lastSystemMessage.count++;
      const contentDiv = lastSystemMessage.element.querySelector('.message-content');
      contentDiv.textContent = `${message} ${lastSystemMessage.count > 1 ? `(${lastSystemMessage.count})` : ''}`;
      
      // 更新消息的显示时间
      updateSystemMessage(message, lastSystemMessage.element);
      return;
    }
    
    // 创建新的系统消息
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', 'system');
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.textContent = message;
    messageElement.appendChild(contentDiv);
    
    // 更新系统消息状态
    updateSystemMessage(message, messageElement);
    
    messagesDiv.appendChild(messageElement);
  } else {
    // 创建基础消息元素
    const messageElement = document.createElement('div');
    messageElement.classList.add('message');
    
    if (type === 'file') {
      messageElement.id = `file-${message.fileId}`;
      const senderName = message.senderId === socket.id ? '我' : 
                        (onlineUsers.get(message.senderId) || '未知用户');
      
      // 添加发送者名称
      const senderDiv = document.createElement('div');
      senderDiv.className = 'sender-name';
      senderDiv.textContent = senderName;
      messageElement.appendChild(senderDiv);
      
      // 创建消息行容器
      const messageRow = document.createElement('div');
      messageRow.className = 'message-row';
      
      // 创建文件消息容器
      const fileContainer = document.createElement('div');
      fileContainer.className = 'file-message';
      
      // 添加文件图标和信息
      const fileInfoSection = document.createElement('div');
      fileInfoSection.className = 'file-info-section';
      fileInfoSection.innerHTML = `
        <div class="file-icon">
          <svg width="24" height="24" viewBox="0 0 24 24">
            <path fill="currentColor" d="M14 2H6C4.89543 2 4 2.89543 4 4V20C4 21.1046 4.89543 22 6 22H18C19.1046 22 20 21.1046 20 20V8L14 2ZM14 4L18 8H14V4ZM16 17H8V15H16V17ZM16 13H8V11H16V13Z"/>
          </svg>
        </div>
        <div class="file-details">
          <div class="file-name">${message.fileName}</div>
          <div class="file-meta">
            <span class="file-size">${formatSize(message.fileSize)}</span>
          </div>
        </div>
      `;
      
      fileContainer.appendChild(fileInfoSection);
      
      // 如果是接收到的文件，添加下载按钮
      if (message.senderId !== socket.id) {
        const downloadButton = document.createElement('button');
        downloadButton.className = 'download-button';
        downloadButton.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
          </svg>
          接收文件
        `;
        downloadButton.onclick = (e) => {
          e.preventDefault();
          try {
            acceptFileTransfer(message.fileId, message.senderId);
            // 不在这里移除按钮，让 acceptFile 函数处理
          } catch (error) {
            console.error('接收文件失败:', error);
            displayMessage('系统: 接收文件失败', 'system');
          }
        };
        fileContainer.appendChild(downloadButton);
      }
      
      // 添加进度条容器（初始隐藏）
      const progressContainer = document.createElement('div');
      progressContainer.className = 'progress-container';
      progressContainer.style.display = 'none';
      progressContainer.innerHTML = `
        <div class="progress-wrapper">
          <div class="progress-bar" style="width: 0%"></div>
        </div>
        <div class="progress-text">0%</div>
        <div class="transfer-speed"></div>
      `;
      fileContainer.appendChild(progressContainer);
      
      messageRow.appendChild(fileContainer);
      messageElement.appendChild(messageRow);
      
      // 如果是自己发送的文件，添加self类
      if (message.senderId === socket.id) {
        messageElement.classList.add('self');
      }
    } else if (type === 'text') {
      // 判断是否是自己发送的消息
      const isSelf = message.startsWith('我: ');
      if (isSelf) {
        messageElement.classList.add('self');
      }
      
      // 分离发送者名称和消息内容
      const [sender, ...contentParts] = message.split(': ');
      const content = contentParts.join(': ');
      
      // 添加发送者名称
      const senderDiv = document.createElement('div');
      senderDiv.className = 'sender-name';
      senderDiv.textContent = sender;
      messageElement.appendChild(senderDiv);
      
      // 创建消息行容器
      const messageRow = document.createElement('div');
      messageRow.className = 'message-row';
      
      // 添加消息内容
      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      contentDiv.textContent = content;
      
      // 添加时间戳
      const timeDiv = document.createElement('div');
      timeDiv.className = 'message-time';
      timeDiv.textContent = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
      });
      contentDiv.appendChild(timeDiv);
      
      messageRow.appendChild(contentDiv);
      messageElement.appendChild(messageRow);
    }
    
    messagesDiv.appendChild(messageElement);
  }
  
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// 判断两条消息是否相似
function isSimularMessage(msg1, msg2) {
  // 移除时间戳和具体用户ID等动态内容
  const normalize = (msg) => msg.replace(/\d+/g, 'X')
                              .replace(/[a-zA-Z0-9-]+/g, 'X');
  return normalize(msg1) === normalize(msg2);
}

export function updateProgressBar(fileId, progress, type = 'download', speed = 0) {
  const fileMessage = document.getElementById(`file-${fileId}`);
  if (!fileMessage) return;
  
  let progressContainer = document.getElementById(`progress-container-${fileId}`);
  
  if (!progressContainer) {
    progressContainer = document.createElement('div');
    progressContainer.className = 'progress-container';
    progressContainer.id = `progress-container-${fileId}`;
    
    progressContainer.innerHTML = `
      <div class="progress-wrapper">
        <div class="progress-bar" id="progress-${fileId}"></div>
      </div>
      <div class="status-container">
        <div class="progress-text" id="progress-text-${fileId}">
          ${type === 'download' ? '准备下载...' : '准备上传...'}
        </div>
        <div class="speed-text" id="speed-${fileId}"></div>
      </div>
    `;
    
    fileMessage.appendChild(progressContainer);
  }
  
  const progressBar = document.getElementById(`progress-${fileId}`);
  const progressText = document.getElementById(`progress-text-${fileId}`);
  const speedText = document.getElementById(`speed-${fileId}`);
  
  // 更新进度条
  progressBar.style.width = `${progress}%`;
  
  // 更新状态文本
  if (progress === 100) {
    progressText.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
      </svg>
      ${type === 'download' ? '下载完成' : '上传完成'}
    `;
    progressText.classList.add('completed');
    progressContainer.classList.add('completed');
  } else {
    progressText.textContent = `${type === 'download' ? '下载中' : '上传中'} ${progress}%`;
  }
  
  // 更新速度显示
  if (speed > 0) {
    speedText.textContent = formatSpeed(speed);
  }
}

// 修改 updateUserList 函数
export function updateUserList(users) {
  const userList = document.getElementById('userList');
  const sidebarTitle = document.querySelector('.sidebar h3');
  userList.innerHTML = '';
  
  // 先添加自己
  const selfUser = users.find(user => user.id === socket.id);
  if (selfUser) {
    const li = document.createElement('li');
    li.textContent = `${selfUser.userId} (我)`;
    li.classList.add('self-user', 'connected');
    userList.appendChild(li);
  }
  
  // 添加其他用户
  users.forEach(user => {
    if (user.id === socket.id) return; // 跳过自己
    
    const li = document.createElement('li');
    const userSpan = document.createElement('span');
    userSpan.textContent = user.userId;
    li.appendChild(userSpan);
    
    // 获取连接状态
    const connection = peerConnections.get(user.id);
    const connectionInfo = connectionAttempts.get(user.id) || { attempts: 0, state: ConnectionState.DISCONNECTED };
    let connectionState = connectionInfo.state;
    
    // 更新连接状态逻辑
    if (connection) {
      if (connection.dataChannel && connection.dataChannel.readyState === 'open') {
        connectionState = ConnectionState.CONNECTED;
      } else if (connection.pc.connectionState === 'connecting' || 
                 connection.pc.connectionState === 'new') {
        connectionState = ConnectionState.CONNECTING;
      } else if (connectionInfo.attempts >= 3) {
        connectionState = ConnectionState.FAILED;
      } else if (connection.pc.connectionState === 'failed' || 
                 connection.pc.connectionState === 'disconnected' ||
                 connection.pc.connectionState === 'closed') {
        connectionState = ConnectionState.DISCONNECTED;
      }
    }
    
    // 添加状态标识
    const statusSpan = document.createElement('span');
    statusSpan.className = 'connection-status';
    switch (connectionState) {
      case ConnectionState.CONNECTING:
        statusSpan.textContent = ' (连接中...)';
        break;
      case ConnectionState.FAILED:
        statusSpan.textContent = ' (连接失败)';
        break;
      case ConnectionState.DISCONNECTED:
        statusSpan.textContent = ' (未连接)';
        break;
    }
    li.appendChild(statusSpan);
    
    // 添加状态类
    li.classList.add(connectionState);
    
    // 添加点击事件（在连接失败或断开时可点击）
    if (connectionState === ConnectionState.FAILED || 
        connectionState === ConnectionState.DISCONNECTED) {
      li.style.cursor = 'pointer';
      li.title = '点击重试连接';
      li.onclick = () => retryConnection(user.id);
    }
    
    userList.appendChild(li);
    
    // 调试日志
    console.log(`用户 ${user.userId} 的连接状态:`, {
      pcState: connection?.pc.connectionState,
      dcState: connection?.dataChannel?.readyState,
      attempts: connectionInfo.attempts,
      resultState: connectionState
    });
  });

  sidebarTitle.textContent = `在线用户 (${users.length})`;
}

// 添加重试连接函数
function retryConnection(peerId) {
  const connectionInfo = connectionAttempts.get(peerId);
  if (connectionInfo) {
    connectionInfo.attempts = 0;
    connectionInfo.state = ConnectionState.CONNECTING;
    connectionAttempts.set(peerId, connectionInfo);
    
    // 调用重连函数
    reconnect(peerId);
    updateUserList([...onlineUsers.entries()].map(([id, userId]) => ({ id, userId })));
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

// 添加显示文件接收提示的函数
export function showFileReceivePrompt(fileInfo) {
  const messagesDiv = document.getElementById('messages');
  const promptElement = document.createElement('div');
  promptElement.classList.add('message', 'file-receive-prompt');
  
  // 创建文件接收提示容器
  const promptContainer = document.createElement('div');
  promptContainer.className = 'file-receive-container';
  
  // 添加文件图标和信息
  const fileInfoSection = document.createElement('div');
  fileInfoSection.className = 'file-info-section';
  fileInfoSection.innerHTML = `
    <div class="file-icon">
      <svg width="24" height="24" viewBox="0 0 24 24">
        <path fill="currentColor" d="M14 2H6C4.89543 2 4 2.89543 4 4V20C4 21.1046 4.89543 22 6 22H18C19.1046 22 20 21.1046 20 20V8L14 2ZM14 4L18 8H14V4ZM16 17H8V15H16V17ZM16 13H8V11H16V13Z"/>
      </svg>
    </div>
    <div class="file-details">
      <div class="file-name">${fileInfo.fileName}</div>
      <div class="file-size">${formatSize(fileInfo.fileSize)}</div>
      <div class="sender-info">来自: ${onlineUsers.get(fileInfo.senderId) || '未知用户'}</div>
    </div>
  `;
  
  // 添加操作按钮
  const actionButtons = document.createElement('div');
  actionButtons.className = 'file-action-buttons';
  
  const acceptButton = document.createElement('button');
  acceptButton.className = 'accept-file-btn';
  acceptButton.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
    </svg>
    接收
  `;
  
  const rejectButton = document.createElement('button');
  rejectButton.className = 'reject-file-btn';
  rejectButton.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/>
    </svg>
    拒绝
  `;
  
  actionButtons.appendChild(acceptButton);
  actionButtons.appendChild(rejectButton);
  
  promptContainer.appendChild(fileInfoSection);
  promptContainer.appendChild(actionButtons);
  promptElement.appendChild(promptContainer);
  
  messagesDiv.appendChild(promptElement);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  
  return new Promise((resolve, reject) => {
    acceptButton.onclick = () => {
      promptElement.remove();
      resolve(true);
    };
    rejectButton.onclick = () => {
      promptElement.remove();
      resolve(false);
    };
  });
}

// ... 其他 UI 相关函数 ... 