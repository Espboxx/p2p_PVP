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

  // 显示模态框
  joinRoomBtn.addEventListener('click', () => {
    modal.style.display = 'block';
    roomInput.value = '';
    roomInput.focus();
  });

  // 隐藏模态框
  cancelJoinBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  // 确认加入房间
  confirmJoinBtn.addEventListener('click', () => {
    const roomId = roomInput.value.trim();
    if (roomId) {
      joinRoom(roomId);
      modal.style.display = 'none';
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
    if (e.target === modal) {
      modal.style.display = 'none';
    }
  });

  // 原有的事件监听
  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('sendFileBtn').addEventListener('click', sendFile);
  
  updateUIState();
}); 