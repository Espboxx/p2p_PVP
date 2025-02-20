import { socket } from './socket.js';
import { displayMessage } from './ui.js';
import { peerConnections } from './webrtc.js';
import { sendFile } from './fileTransfer.js';

// 检查是否有活跃连接
function hasActiveConnections() {
  let hasActive = false;
  peerConnections.forEach(({ dataChannel }) => {
    if (dataChannel && dataChannel.readyState === 'open') {
      hasActive = true;
    }
  });
  return hasActive;
}

// 表情数据
const emojiCategories = {
  frequently: [],  // 将根据使用频率动态填充
  smileys: ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘'],
  people: ['👶', '👧', '🧒', '👦', '👩', '🧑', '👨', '👩‍🦱', '👨‍🦱', '👩‍🦰', '👨‍🦰', '👱‍♀️', '👱‍♂️'],
  nature: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸'],
  food: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍈', '🍒', '🍑', '🥭', '🍍'],
  activities: ['⚽️', '🏀', '🏈', '⚾️', '🥎', '🎾', '🏐', '🏉', '🎱', '🏓', '🏸', '🏒', '🏑', '🥅'],
  objects: ['⌚️', '📱', '📲', '💻', '⌨️', '🖥', '🖨', '🖱', '🖲', '🕹', '🗜', '💽', '💾', '💿'],
  symbols: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓'],
  flags: ['🏳️', '🏴', '🏁', '🚩', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️', '🇦🇫', '🇦🇽', '🇦🇱', '🇩🇿', '🇦🇸', '🇦🇩', '🇦🇴']
};

let currentCategory = 'frequently';
let recentlyUsedEmojis = new Set();

// 初始化表情选择器
export function initEmojiPicker() {
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiPanel = document.getElementById('emojiPanel');
  const emojiList = document.getElementById('emojiList');
  const emojiSearch = document.getElementById('emojiSearch');
  const messageInput = document.getElementById('messageInput');

  if (!emojiBtn || !emojiPanel || !emojiList || !emojiSearch || !messageInput) {
    console.error('表情选择器初始化失败：找不到必要的DOM元素');
    return;
  }

  // 加载最近使用的表情
  loadRecentEmojis();

  // 点击表情按钮显示/隐藏面板
  emojiBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    emojiPanel.classList.toggle('active');
    if (emojiPanel.classList.contains('active')) {
      renderEmojiList(currentCategory);
      // 确保表情面板在视口内
      const panelRect = emojiPanel.getBoundingClientRect();
      if (panelRect.top < 0) {
        emojiPanel.style.bottom = 'unset';
        emojiPanel.style.top = '100%';
      }
    }
  });

  // 切换表情类别
  document.querySelectorAll('.emoji-categories button').forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelector('.emoji-categories button.active')?.classList.remove('active');
      button.classList.add('active');
      currentCategory = button.dataset.category;
      renderEmojiList(currentCategory);
    });
  });

  // 搜索表情
  let searchTimeout;
  emojiSearch.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const searchTerm = e.target.value.toLowerCase().trim();
      if (searchTerm) {
        const allEmojis = Object.values(emojiCategories).flat();
        const filteredEmojis = allEmojis.filter(emoji => 
          emoji.toLowerCase().includes(searchTerm)
        );
        renderEmojiList('search', filteredEmojis);
      } else {
        renderEmojiList(currentCategory);
      }
    }, 300);
  });

  // 点击选择表情
  emojiList.addEventListener('click', (e) => {
    const emojiItem = e.target.closest('.emoji-item');
    if (emojiItem) {
      e.preventDefault();
      const emoji = emojiItem.textContent;
      insertEmoji(emoji);
      addToRecentEmojis(emoji);
    }
  });

  // 点击外部关闭表情面板
  document.addEventListener('click', (e) => {
    if (!emojiPanel.contains(e.target) && !emojiBtn.contains(e.target)) {
      emojiPanel.classList.remove('active');
    }
  });

  // ESC键关闭表情面板
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && emojiPanel.classList.contains('active')) {
      emojiPanel.classList.remove('active');
    }
  });
}

// 渲染表情列表
function renderEmojiList(category, customEmojis = null) {
  const emojiList = document.getElementById('emojiList');
  if (!emojiList) return;

  emojiList.innerHTML = '';
  
  const emojis = customEmojis || emojiCategories[category];
  if (!emojis || emojis.length === 0) {
    const emptyMessage = document.createElement('div');
    emptyMessage.className = 'empty-emoji-message';
    emptyMessage.textContent = category === 'frequently' ? '还没有常用表情' : '没有找到表情';
    emojiList.appendChild(emptyMessage);
    return;
  }

  emojis.forEach(emoji => {
    const div = document.createElement('div');
    div.className = 'emoji-item';
    div.textContent = emoji;
    div.title = emoji;
    emojiList.appendChild(div);
  });
}

// 插入表情到输入框
function insertEmoji(emoji) {
  const messageInput = document.getElementById('messageInput');
  if (!messageInput) return;

  const start = messageInput.selectionStart;
  const end = messageInput.selectionEnd;
  const text = messageInput.value;
  messageInput.value = text.substring(0, start) + emoji + text.substring(end);
  messageInput.selectionStart = messageInput.selectionEnd = start + emoji.length;
  messageInput.focus();

  // 触发input事件以更新输入框高度
  messageInput.dispatchEvent(new Event('input'));
}

// 保存最近使用的表情
function addToRecentEmojis(emoji) {
  recentlyUsedEmojis.add(emoji);
  if (recentlyUsedEmojis.size > 30) {
    recentlyUsedEmojis.delete([...recentlyUsedEmojis][0]);
  }
  emojiCategories.frequently = [...recentlyUsedEmojis];
  try {
    localStorage.setItem('recentEmojis', JSON.stringify([...recentlyUsedEmojis]));
  } catch (error) {
    console.error('保存最近使用的表情失败:', error);
  }
}

// 加载最近使用的表情
function loadRecentEmojis() {
  try {
    const saved = localStorage.getItem('recentEmojis');
    if (saved) {
      recentlyUsedEmojis = new Set(JSON.parse(saved));
      emojiCategories.frequently = [...recentlyUsedEmojis];
    }
  } catch (error) {
    console.error('加载最近使用的表情失败:', error);
  }
}

// 处理图片粘贴
export function initImagePaste() {
  const messageInput = document.getElementById('messageInput');
  const imagePreviewModal = document.getElementById('imagePreviewModal');
  const imagePreview = document.getElementById('imagePreview');
  const confirmImageSend = document.getElementById('confirmImageSend');
  const cancelImageSend = document.getElementById('cancelImageSend');
  const closeImagePreview = document.getElementById('closeImagePreview');

  let currentImageData = null;

  // 监听粘贴事件
  messageInput.addEventListener('paste', (e) => {
    const items = e.clipboardData.items;
    for (let item of items) {
      if (item.type.startsWith('image')) {
        e.preventDefault();
        const file = item.getAsFile();
        handleImageFile(file);
        break;
      }
    }
  });

  // 处理图片文件
  function handleImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      currentImageData = e.target.result;
      imagePreview.src = currentImageData;
      imagePreviewModal.classList.add('active');
    };
    reader.readAsDataURL(file);
  }

  // 确认发送图片
  const sendImageHandler = () => {
    if (currentImageData) {
      sendImage(currentImageData);
      closeImagePreviewModal();
    }
  };

  // 取消发送
  function closeImagePreviewModal() {
    imagePreviewModal.classList.remove('active');
    currentImageData = null;
    imagePreview.src = '';
  }

  // 移除之前的事件监听器，只添加一个
  confirmImageSend.onclick = sendImageHandler;
  cancelImageSend.onclick = closeImagePreviewModal;
  closeImagePreview.onclick = closeImagePreviewModal;

  // 点击模态框外部关闭
  imagePreviewModal.onclick = (e) => {
    if (e.target === imagePreviewModal) {
      closeImagePreviewModal();
    }
  };

  // 修改文件输入以支持所有文件类型
  const fileInput = document.getElementById('fileInput');
  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.type.startsWith('image/')) {
        handleImageFile(file);
      } else {
        // 对于非图片文件，直接调用 sendFile
        sendFile(file);
      }
    }
    fileInput.value = ''; // 清空输入，允许选择相同的文件
  };
}

// 发送图片消息
function sendImage(imageData) {
  // 检查是否有活跃连接
  if (!hasActiveConnections()) {
    displayMessage('系统: 没有可用的连接，无法发送图片', 'system');
    return;
  }

  const imageId = `img-${Date.now()}`;
  const message = {
    type: 'image',
    data: imageData,
    senderId: socket.id,
    imageId
  };

  // 创建进度消息
  const messageElement = document.createElement('div');
  messageElement.className = 'message self';
  messageElement.id = `image-message-${imageId}`;
  
  messageElement.innerHTML = `
    <div class="file-message">
      <div class="file-info-section">
        <div class="file-icon">
          <svg viewBox="0 0 24 24">
            <path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
          </svg>
        </div>
        <div class="file-details">
          <div class="file-name">图片</div>
          <div class="file-meta">发送中...</div>
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
  peerConnections.forEach(({ dataChannel }, peerId) => {
    if (dataChannel && dataChannel.readyState === 'open') {
      try {
        // 分块发送大图片
        const chunkSize = 16384; // 16KB
        const totalChunks = Math.ceil(imageData.length / chunkSize);
        let sentChunks = 0;
        
        const updateProgress = () => {
          const progress = Math.round((sentChunks / totalChunks) * 100);
          const progressBar = messageElement.querySelector('.progress-bar');
          const progressText = messageElement.querySelector('.progress-text');
          if (progressBar) {
            progressBar.style.width = `${progress}%`;
          }
          if (progressText) {
            progressText.textContent = `发送中... ${progress}%`;
          }
        };

        // 分块发送
        for (let i = 0; i < totalChunks; i++) {
          const chunk = imageData.slice(i * chunkSize, (i + 1) * chunkSize);
          const chunkMessage = {
            type: 'image-chunk',
            imageId,
            chunkIndex: i,
            totalChunks,
            data: chunk
          };
          dataChannel.send(JSON.stringify(chunkMessage));
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
          
          // 显示图片
          const imageContainer = document.createElement('div');
          imageContainer.className = 'image-container';
          imageContainer.innerHTML = `<img src="${imageData}" alt="发送的图片">`;
          messageElement.querySelector('.file-message').appendChild(imageContainer);
        }
      } catch (error) {
        console.error(`向 ${peerId} 发送图片失败:`, error);
        const progressText = messageElement.querySelector('.progress-text');
        if (progressText) {
          progressText.textContent = '发送失败';
          progressText.style.color = 'var(--danger-color)';
        }
      }
    }
  });
}

// 处理接收到的图片块
export function handleImageChunk(message, senderId) {
  const { imageId, chunkIndex, totalChunks, data } = message;
  
  // 初始化或获取图片数据存储
  if (!imageChunks.has(imageId)) {
    imageChunks.set(imageId, {
      chunks: new Array(totalChunks).fill(null),
      messageElement: null
    });
    
    // 创建进度消息
    const messageElement = document.createElement('div');
    messageElement.className = 'message';
    messageElement.id = `image-message-${imageId}`;
    
    messageElement.innerHTML = `
      <div class="file-message">
        <div class="file-info-section">
          <div class="file-icon">
            <svg viewBox="0 0 24 24">
              <path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
            </svg>
          </div>
          <div class="file-details">
            <div class="file-name">图片</div>
            <div class="file-meta">接收中...</div>
          </div>
        </div>
        <div class="progress-container">
          <div class="progress-wrapper">
            <div class="progress-bar" style="width: 0%"></div>
          </div>
          <div class="status-container">
            <div class="progress-text">接收中...</div>
            <div class="speed-text"></div>
          </div>
        </div>
      </div>
    `;

    const messagesDiv = document.getElementById('messages');
    messagesDiv.appendChild(messageElement);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    imageChunks.get(imageId).messageElement = messageElement;
  }
  
  const imageData = imageChunks.get(imageId);
  imageData.chunks[chunkIndex] = data;
  
  // 更新进度
  const receivedChunks = imageData.chunks.filter(chunk => chunk !== null).length;
  const progress = Math.round((receivedChunks / totalChunks) * 100);
  
  const progressBar = imageData.messageElement.querySelector('.progress-bar');
  const progressText = imageData.messageElement.querySelector('.progress-text');
  
  if (progressBar) {
    progressBar.style.width = `${progress}%`;
  }
  if (progressText) {
    progressText.textContent = `接收中... ${progress}%`;
  }
  
  // 检查是否接收完成
  if (receivedChunks === totalChunks) {
    const completeImageData = imageData.chunks.join('');
    const progressContainer = imageData.messageElement.querySelector('.progress-container');
    const progressText = imageData.messageElement.querySelector('.progress-text');
    
    if (progressContainer) {
      progressContainer.classList.add('completed');
    }
    if (progressText) {
      progressText.textContent = '接收完成';
    }
    
    // 显示图片
    const imageContainer = document.createElement('div');
    imageContainer.className = 'image-container';
    imageContainer.innerHTML = `<img src="${completeImageData}" alt="接收的图片">`;
    imageData.messageElement.querySelector('.file-message').appendChild(imageContainer);
    
    // 清理存储
    imageChunks.delete(imageId);
  }
}

// 存储接收的图片块
const imageChunks = new Map();

// 初始化功能
document.addEventListener('DOMContentLoaded', () => {
  initEmojiPicker();
  initImagePaste();
}); 