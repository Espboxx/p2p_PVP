import { createPeerConnection, peerConnections, handleSignal } from './webrtc.js';
import { 
  displayMessage, 
  updateUserList, 
  updateUIState
} from './ui.js';
import { 
  ConnectionState,
  updateConnectionState,
  connectionAttempts 
} from './connectionState.js';
import { io } from './io.js';

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
  
  // 检查是否有未知用户
  const unknownUsers = members.filter(member => !member.userId);
  if (unknownUsers.length > 0) {
    console.warn('检测到未知用户，不加入房间:', unknownUsers);
    displayMessage('系统: 检测到异常用户，已自动退出房间', 'system');
    leaveRoom();
    return;
  }
  
  const roomDisplay = document.getElementById('roomDisplay');
  roomDisplay.textContent = `房间: ${roomId}`;
  currentRoom = roomId;
  
  document.getElementById('chatSection').classList.remove('hidden');
  
  // 更新在线用户列表
  onlineUsers.clear();
  members.forEach(member => {
    if (member.userId) {
      onlineUsers.set(member.id, {
        userId: member.userId,
        ip: member.ip || 'unknown'
      });
    }
  });
  
  // 更新UI显示
  updateUserList(members);
  
  if (members.length <= 1) {
    displayMessage(`系统: 已成功加入房间 ${roomId}`, 'system');
    displayMessage('系统: 当前房间暂无其他用户，等待用户加入...', 'system');
  } else {
    displayMessage(`系统: 已成功加入房间 ${roomId}`, 'system');
    displayMessage(`系统: 当前房间有 ${members.length - 1} 个其他用户`, 'system');
    
    // 显示正在连接的用户列表
    const otherMembers = members.filter(m => m.id !== socket.id);
    
    // 为每个现有成员初始化连接状态
    otherMembers.forEach(member => {
      updateConnectionState(member.id, ConnectionState.CONNECTING, {
        onlineUsers,
        updateUserList,
        displayMessage
      });
      createPeerConnection(member.id).catch(err => {
        console.error(`创建与 ${member.userId} 的连接失败:`, err);
        updateConnectionState(member.id, ConnectionState.DISCONNECTED, {
          onlineUsers,
          updateUserList,
          displayMessage
        });
      });
    });
  }
});

socket.on('room-users-updated', (members) => {
  console.log('收到用户列表更新:', members);
  
  // 检查是否有未知用户
  const unknownUsers = members.filter(member => !member.userId);
  if (unknownUsers.length > 0) {
    console.warn('检测到未知用户:', unknownUsers);
    return;
  }
  
  // 更新本地用户列表
  onlineUsers.clear();
  members.forEach(member => {
    if (member.userId) {
      onlineUsers.set(member.id, {
        userId: member.userId,
        ip: member.ip || 'unknown'
      });
      console.log(`在线用户: ${member.userId} (${member.id})`);
    }
  });
  
  // 立即更新UI显示
  updateUserList(members);
});

socket.on('user-connected', ({ id, userId, ip }) => {
  if (!userId) {
    console.warn('检测到未知用户尝试连接:', id);
    return;
  }
  
  console.log(`新用户 ${userId} (${id}) 加入，IP: ${ip}`);
  displayMessage(`系统: 用户 ${userId} 已加入房间`, 'system');
  onlineUsers.set(id, {
    userId,
    ip: ip || 'unknown'
  });
  
  // 只为有效用户创建连接
  updateConnectionState(id, ConnectionState.CONNECTING, {
    onlineUsers,
    updateUserList,
    displayMessage
  });
  
  createPeerConnection(id).catch(err => {
    console.error(`创建与 ${userId} 的连接失败:`, err);
    updateConnectionState(id, ConnectionState.DISCONNECTED, {
      onlineUsers,
      updateUserList,
      displayMessage
    });
  });
});

socket.on('user-disconnected', (id) => {
  const disconnectedUserId = onlineUsers.get(id);
  if (disconnectedUserId) {
    console.log(`用户断开: ${disconnectedUserId.userId} (${id})`);
    displayMessage(`系统: 用户 ${disconnectedUserId.userId} 已离开`, 'system');
    
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
socket.on('connect', async () => {
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

// 在连接失败的处理中
socket.on('connection-failed', (peerId) => {
  const connectionInfo = connectionAttempts.get(peerId);
  if (connectionInfo && connectionInfo.attempts >= 3) {
    updateConnectionState(peerId, ConnectionState.FAILED, {
      onlineUsers,
      updateUserList,
      displayMessage
    });
  } else {
    updateConnectionState(peerId, ConnectionState.CONNECTING, {
      onlineUsers,
      updateUserList,
      displayMessage
    });
    // 自动重试
    setTimeout(() => reconnect(peerId), 1000);
  }
});

// 监听连接状态变化
socket.on('peer-connection-state', ({ fromId, targetId, state, dataChannelState }) => {
  console.log(`收到连接状态更新:`, { fromId, targetId, state, dataChannelState });
  
  let connectionState;
  if (dataChannelState === 'open') {
    connectionState = ConnectionState.CONNECTED;
  } else if (state === 'connecting' || state === 'new') {
    connectionState = ConnectionState.CONNECTING;
  } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
    const connectionInfo = connectionAttempts.get(targetId);
    if (connectionInfo && connectionInfo.attempts >= 3) {
      connectionState = ConnectionState.FAILED;
    } else {
      connectionState = ConnectionState.DISCONNECTED;
    }
  }

  if (connectionState) {
    updateConnectionState(targetId, connectionState, {
      onlineUsers,
      updateUserList,
      displayMessage
    });
  }
});

// 添加退出房间的函数
function leaveRoom() {
  if (currentRoom) {
    // 关闭所有对等连接
    peerConnections.forEach((connection, peerId) => {
      if (connection.pc) {
        connection.pc.close();
      }
      if (connection.dataChannel) {
        connection.dataChannel.close();
      }
    });
    peerConnections.clear();
    
    // 清空在线用户列表
    onlineUsers.clear();
    
    // 通知服务器离开房间
    socket.emit('leave-room', currentRoom);
    
    // 重置房间状态
    currentRoom = null;
    
    // 更新UI
    const roomDisplay = document.getElementById('roomDisplay');
    roomDisplay.textContent = '未加入房间';
    
    document.getElementById('chatSection').classList.add('hidden');
    displayMessage('系统: 已退出房间', 'system');
    updateUIState();
    
    // 显示重新加入按钮
    const rejoinBtn = document.createElement('button');
    rejoinBtn.textContent = '重新加入公共房间';
    rejoinBtn.onclick = () => {
      rejoinBtn.remove();
      joinRoom(DEFAULT_ROOM);
    };
    document.getElementById('messages').appendChild(rejoinBtn);
  }
}

// 修改连接处理
io.on('connection', (socket) => {
  const clientIp = getClientIp(socket);
  console.log(`新连接: ${socket.id} (IP: ${clientIp})`);

  // 加入房间处理
  socket.on('join-room', (roomId) => {
    try {
      if (!roomId) {
        return socket.emit('error', 'Room ID cannot be empty');
      }

      const userId = socket.handshake.query.userId;
      if (!userId) {
        return socket.emit('error', 'User ID cannot be empty');
      }

      // 离开之前的房间
      if (socket.room) {
        socket.leave(socket.room);
        rooms.get(socket.room)?.delete(socket.id);
      }

      socket.join(roomId);
      socket.room = roomId;

      if (!addUserToRoom(socket, roomId, userId)) {
        return socket.emit('error', 'Failed to join room');
      }

      // 存储用户IP信息
      const userInfo = {
        userId,
        roomId,
        ip: clientIp
      };
      users.set(socket.id, userInfo);

      const members = getRoomMembers(roomId);

      // 发送加入成功消息给新用户
      socket.emit('room-joined', {
        roomId,
        members: members.map(member => ({
          ...member,
          ip: users.get(member.id)?.ip
        }))
      });

      // 广播给所有用户更新后的用户列表
      io.in(roomId).emit('room-users-updated', members.map(member => ({
        ...member,
        ip: users.get(member.id)?.ip
      })));

      // 通知其他用户有新用户加入
      socket.to(roomId).emit('user-connected', {
        id: socket.id,
        userId,
        ip: clientIp
      });

      console.log(`用户加入房间:`, {
        userId,
        roomId,
        ip: clientIp,
        socketId: socket.id
      });
    } catch (error) {
      console.error('Error in join-room:', error);
      socket.emit('error', 'Internal server error');
    }
  });

  // ... existing code ...
}); 