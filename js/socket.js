import { createPeerConnection, peerConnections, handleSignal } from './webrtc.js';
import { displayMessage, updateUserList, updateUIState } from './ui.js';

// 在文件开头添加默认房间常量
const DEFAULT_ROOM = 'public';

// 生成随机用户ID
const userId = Math.random().toString(36).substring(2, 8);
export const socket = io({ query: { userId } });

export let currentRoom = null;
export const onlineUsers = new Map(); // key: socketId, value: userId

// Socket事件处理
socket.on('room-joined', ({ roomId, members }) => {
  console.log(`成功加入房间 ${roomId}，成员列表:`, members);
  const statusDiv = document.getElementById('connectionStatus');
  statusDiv.textContent = `✓ 已加入房间 ${roomId} (用户ID: ${userId})`;
  statusDiv.style.color = 'green';
  
  document.getElementById('chatSection').classList.remove('hidden');
  
  if (members.length <= 1) {
    // 如果只有自己一个人
    displayMessage(`系统: 已成功加入房间 ${roomId}`, 'system');
    displayMessage('系统: 当前房间暂无其他用户，等待用户加入...', 'system');
  } else {
    displayMessage(`系统: 已成功加入房间 ${roomId}`, 'system');
    displayMessage(`系统: 当前房间有 ${members.length - 1} 个其他用户`, 'system');
    displayMessage('系统: 正在建立点对点连接...', 'system');
  }
  
  // 自动连接现有成员
  members.forEach(({ id }) => {
    if (id !== socket.id && !peerConnections.has(id)) {
      createPeerConnection(id);
    }
  });
});

socket.on('room-users-updated', (members) => {
  console.log('收到用户列表更新:', members);
  
  // 更新本地用户列表
  onlineUsers.clear();
  members.forEach(member => {
    onlineUsers.set(member.id, member.userId);
    console.log(`在线用户: ${member.userId} (${member.id})`);
  });
  
  updateUserList(members);
});

socket.on('user-connected', async ({ id, userId }) => {
  console.log(`新用户 ${userId} (${id}) 加入`);
  if (!peerConnections.has(id)) {
    const pc = await createPeerConnection(id);
    console.log(`已创建与 ${id} 的对等连接`);
  }
  displayMessage(`系统: 用户 ${userId} 已加入房间`, 'system');
});

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
      updateUIState();
    }
  }
});

socket.on('signal', async ({ from, signal }) => {
  await handleSignal(from, signal);
});

// 修改 socket 连接后的逻辑
socket.on('connect', () => {
  // 自动加入公共聊天室
  joinRoom(DEFAULT_ROOM);
});

// 修改 joinRoom 函数
export function joinRoom(roomId) {
  if (!roomId) {
    return alert('请输入房间号');
  }
  
  const statusDiv = document.getElementById('connectionStatus');
  statusDiv.textContent = '正在连接房间...';
  statusDiv.style.color = '#666';

  // 添加连接中的提示消息
  displayMessage(`系统: 正在连接到房间 ${roomId}...`, 'system');
  displayMessage('系统: 正在等待其他用户加入...', 'system');
  
  currentRoom = roomId;
  socket.emit('join-room', currentRoom);
  
  document.getElementById('chatSection').classList.remove('hidden');
  updateUIState();
} 