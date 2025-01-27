import { socket, joinRoom } from './socket.js';
import { sendMessage } from './dataChannel.js';
import { sendFile } from './fileTransfer.js';
import { updateUIState } from './ui.js';

// 初始化事件监听
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('roomModal');
  const joinRoomBtn = document.getElementById('joinRoomBtn');
  const cancelJoinBtn = document.getElementById('cancelJoinBtn');
  const confirmJoinBtn = document.getElementById('confirmJoinBtn');
  const roomInput = document.getElementById('roomId');
  const fileInput = document.getElementById('fileInput');
  const messageInput = document.getElementById('messageInput');

  // 显示模态框
  document.getElementById('joinRoomBtn').addEventListener('click', (e) => {
    e.stopPropagation(); // 阻止事件冒泡
    modal.classList.add('active');
    roomInput.value = '';
    roomInput.focus();
  });

  // 隐藏模态框
  cancelJoinBtn.addEventListener('click', () => {
    modal.classList.remove('active');
  });

  // 确认加入房间
  confirmJoinBtn.addEventListener('click', async () => {
    const roomId = roomInput.value.trim();
    if (roomId) {
      confirmJoinBtn.classList.add('loading');
      try {
        await joinRoom(roomId);
        modal.classList.remove('active');
      } finally {
        confirmJoinBtn.classList.remove('loading');
      }
    }
  });

  // 按 Enter 键确认
  roomInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      confirmJoinBtn.click();
    }
  });

  // 点击模态框外部关闭
  modal.addEventListener('click', (e) => {
    // 检查点击的是否是模态框背景（排除子元素）
    if (e.target === modal && !modal.contains(e.target.closest('.modal'))) {
      modal.classList.remove('active');
    }
  });

  // 发送消息按钮
  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  
  // 文件上传处理
  let isProcessingFile = false;
  
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0 && !isProcessingFile) {
      isProcessingFile = true;
      sendFile();
      // 重置文件输入框，允许选择相同文件
      fileInput.value = '';
      isProcessingFile = false;
    }
  });
  
  // 文件上传图标点击事件（不需要额外的处理器，因为label已经关联了input）
  updateUIState();

  // 处理输入框的键盘事件
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (!e.shiftKey) {
        e.preventDefault(); // 阻止默认的换行行为
        const sendBtn = document.getElementById('sendBtn');
        if (!sendBtn.disabled) {
          sendMessage();  // 直接调用 sendMessage 而不是触发按钮点击
        }
      }
    }
  });

  // 自动调整输入框高度
  function adjustInputHeight(input) {
    // 保存当前滚动位置
    const scrollPos = input.scrollTop;
    
    // 重置高度
    input.style.height = 'auto';
    
    // 计算新高度
    const newHeight = Math.min(input.scrollHeight, 144);
    input.style.height = newHeight + 'px';
    
    // 恢复滚动位置
    input.scrollTop = scrollPos;
    
    // 更新输入区域的对齐方式
    const inputArea = input.closest('.input-area');
    if (inputArea) {
      inputArea.style.alignItems = newHeight > 44 ? 'flex-start' : 'flex-end';
    }
  }

  // 在 DOMContentLoaded 事件监听器中
  messageInput.addEventListener('input', () => {
    adjustInputHeight(messageInput);
  });

  // 初始化时设置一次
  adjustInputHeight(messageInput);

  // 处理粘贴事件
  messageInput.addEventListener('paste', (e) => {
    // 延迟执行以确保内容已经粘贴
    setTimeout(() => {
      adjustInputHeight(messageInput);
    }, 0);
  });

  // 处理窗口大小改变
  window.addEventListener('resize', () => {
    adjustInputHeight(messageInput);
  });
}); 