import { ConnectionState, connectionAttempts } from './connectionState.js';
import { peerConnections } from './webrtc.js';
import { socket, onlineUsers } from './socket.js';
import { formatSize, formatSpeed } from './utils.js';
import { reconnect } from './webrtc.js';
import { sendFile, acceptFileTransfer } from './fileTransfer.js';
import { FILE_CONFIG, TransferState } from './config.js';
import { ongoingTransfers } from './fileTransfer.js';

let sidebarCollapsed = false;

// 添加一个用于存储最近系统消息的变量
let lastSystemMessage = {
  text: '',
  element: null,
  count: 0,
  timer: null
};

// 添加错误显示函数
export function showError(message) {
  console.error(message);
  displayMessage(`系统: ${message}`, 'system');
}

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
        const chunks = Math.ceil(file.size / FILE_CONFIG.chunkSize);

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
  const messageInput = document.getElementById('messageInput');
  const sendButton = document.getElementById('sendBtn');
  const fileInput = document.getElementById('fileInput');
  const fileButton = document.querySelector('.file-upload-btn');
  
  // 添加元素存在性检查
  if (!messageInput || !sendButton || !fileInput || !fileButton) {
    console.warn('UI元素未找到:', { messageInput, sendButton, fileInput, fileButton });
    return;
  }

  // 检查是否有任何一个连接成功且数据通道打开的用户
  let hasConnectedPeer = false;
  peerConnections.forEach(({ pc, dataChannel }) => {
    if (pc.connectionState === 'connected' && 
        dataChannel && 
        dataChannel.readyState === 'open') {
      hasConnectedPeer = true;
    }
  });

  // 如果有至少一个连接成功的用户，启用所有输入控件
  if (hasConnectedPeer) {
    messageInput.disabled = false;
    sendButton.disabled = false;
    fileInput.disabled = false;
    fileButton.style.pointerEvents = 'auto';
    fileButton.style.opacity = '1';
    messageInput.placeholder = '输入消息...';
  } else {
    messageInput.disabled = true;
    sendButton.disabled = true;
    fileInput.disabled = true;
    fileButton.style.pointerEvents = 'none';
    fileButton.style.opacity = '0.5';
    messageInput.placeholder = hasConnectingPeers() ? '正在建立连接...' : '等待其他用户加入...';
  }

  // 更新用户列表，同时显示连接和数据通道状态
  const userList = Array.from(onlineUsers.entries()).map(([id, userData]) => {
    const connection = peerConnections.get(id);
    return {
      id,
      userId: userData.userId || userData, // 兼容旧格式
      ip: userData.ip || 'unknown',
      connectionState: connection?.pc.connectionState || 'new',
      dataChannelState: connection?.dataChannel?.readyState || 'closed'
    };
  });
  
  updateUserList(userList);

  // 更新用户ID显示
  const userIdText = document.getElementById('userIdText');
  if (userIdText && socket.id) {
    const userData = onlineUsers.get(socket.id);
    userIdText.textContent = userData?.userId || userData || socket.id;
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
    if (!userList) return;
    
    // 清空现有列表
    userList.innerHTML = '';
    
    // 分离当前用户和其他用户
    const currentUser = users.find(user => user.id === socket.id);
    const otherUsers = users.filter(user => user.id !== socket.id);
    
    // 如果当前用户存在，添加到列表顶部
    if (currentUser) {
        const li = document.createElement('li');
        li.classList.add('self-user');
        
        // 添加状态指示器
        const statusIndicator = document.createElement('span');
        statusIndicator.className = 'status-indicator';
        
        // 添加编辑按钮
        const editButton = document.createElement('button');
        editButton.className = 'edit-user-btn';
        editButton.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
        `;
        
        // 添加用户名称和IP
        const userInfo = document.createElement('div');
        userInfo.className = 'user-info';
        userInfo.innerHTML = `
            <span class="user-name">${currentUser.userId} (我)</span>
            <span class="user-ip">${currentUser.ip}</span>
        `;
        
        // 添加状态文本
        const statusText = document.createElement('span');
        statusText.className = 'connection-status';
        statusText.textContent = '在线';
        
        // 组装元素
        li.appendChild(statusIndicator);
        li.appendChild(editButton);
        li.appendChild(userInfo);
        li.appendChild(statusText);
        
        // 添加编辑功能
        editButton.addEventListener('click', () => {
            const newId = prompt('请输入新的用户ID:', currentUser.userId);
            if (newId && newId !== currentUser.userId) {
                socket.emit('change-user-id', {
                    newId: newId
                });
            }
        });
        
        userList.appendChild(li);
    }
    
    // 如果没有其他用户且当前用户也不存在
    if (otherUsers.length === 0 && !currentUser) {
        const li = document.createElement('li');
        li.className = 'no-users';
        li.textContent = '暂无其他用户';
        userList.appendChild(li);
        return;
    }
    
    // 添加其他用户到列表
    otherUsers.forEach(user => {
        const li = document.createElement('li');
        
        // 获取连接状态
        const connection = peerConnections.get(user.id);
        const connectionInfo = connectionAttempts.get(user.id) || { attempts: 0 };
        let connectionState = ConnectionState.DISCONNECTED;
        
        // 更新连接状态
        if (connection) {
            if (connection.dataChannel?.readyState === 'open' && 
                connection.pc.connectionState === 'connected') {
                connectionState = ConnectionState.CONNECTED;
            } else if (connection.pc.connectionState === 'connecting' || 
                     connection.pc.connectionState === 'new' ||
                     connection.dataChannel?.readyState === 'connecting') {
                connectionState = ConnectionState.CONNECTING;
            } else if (connection.pc.connectionState === 'failed' || 
                     connection.pc.connectionState === 'disconnected' || 
                     connection.pc.connectionState === 'closed') {
                connectionState = connectionInfo.attempts >= 3 ? 
                                 ConnectionState.FAILED : 
                                 ConnectionState.DISCONNECTED;
            }
        }
        
        // 设置状态样式
        li.classList.add(connectionState.toLowerCase());
        
        // 添加状态指示器
        const statusIndicator = document.createElement('span');
        statusIndicator.className = 'status-indicator';
        
        // 添加用户名称和IP
        const userInfo = document.createElement('div');
        userInfo.className = 'user-info';
        userInfo.innerHTML = `
            <span class="user-name">${user.userId}</span>
            <span class="user-ip">${user.ip}</span>
        `;
        
        // 添加状态文本
        const statusText = document.createElement('span');
        statusText.className = 'connection-status';
        switch (connectionState) {
            case ConnectionState.CONNECTED:
                statusText.textContent = '已连接';
                break;
            case ConnectionState.CONNECTING:
                statusText.textContent = '连接中...';
                break;
            case ConnectionState.DISCONNECTED:
                statusText.textContent = '未连接';
                break;
            case ConnectionState.FAILED:
                statusText.textContent = '连接失败';
                break;
        }
        
        // 组装元素
        li.appendChild(statusIndicator);
        li.appendChild(userInfo);
        li.appendChild(statusText);
        userList.appendChild(li);
    });
    
    // 触发重新渲染
    userList.style.display = 'none';
    userList.offsetHeight; // 强制重排
    userList.style.display = '';
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
  peerConnections.forEach(({ pc, dataChannel }) => {
    // 检查连接状态和数据通道状态
    if ((pc.connectionState === 'connecting' || pc.connectionState === 'new') ||
        (dataChannel && dataChannel.readyState === 'connecting')) {
      hasConnecting = true;
    }
  });
  return hasConnecting;
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

// 添加用户ID编辑功能
export function setupUserIdEdit() {
    const userIdDisplay = document.createElement('div');
    userIdDisplay.id = 'userIdDisplay';
    userIdDisplay.className = 'user-id-display';
    
    const userIdText = document.createElement('span');
    userIdText.id = 'userIdText';
    userIdText.className = 'user-id-text';
    
    const editButton = document.createElement('button');
    editButton.id = 'editUserIdBtn';
    editButton.className = 'edit-user-id-btn';
    editButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
    `;
    
    userIdDisplay.appendChild(userIdText);
    userIdDisplay.appendChild(editButton);
    
    // 添加到页面
    const header = document.querySelector('.chat-header');
    if (header) {
        header.appendChild(userIdDisplay);
    }
    
    // 编辑功能
    editButton.addEventListener('click', () => {
        const currentId = userIdText.textContent;
        const newId = prompt('请输入新的用户ID:', currentId);
        
        if (newId && newId !== currentId) {
            // 发送ID更改请求到服务器
            socket.emit('change-user-id', {
                newId: newId
            });
        }
    });
    
    // 监听ID更改结果
    socket.on('user-id-changed', ({ success, userId, error }) => {
        if (success) {
            userIdText.textContent = userId;
            displayMessage(`系统: 你的用户ID已更改为 ${userId}`, 'system');
        } else {
            displayMessage(`系统: 更改用户ID失败 - ${error}`, 'system');
        }
    });
    
    return userIdDisplay;
}

// ... 其他 UI 相关函数 ... 