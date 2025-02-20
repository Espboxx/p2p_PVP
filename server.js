const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).send('Something broke!');
});

// 配置静态文件服务
app.use(express.static(__dirname));

// 房间存储结构 {房间号: {客户端ID: 用户信息}}
const rooms = new Map();

// 用户信息存储 {socketId: {userId, roomId}}
const users = new Map();

// 添加一个辅助函数来获取房间成员列表
function getRoomMembers(roomId) {
  try {
    const room = rooms.get(roomId);
    if (!room) return [];
    const members = Array.from(room.entries()).map(([id, user]) => ({
      id,
      userId: user.userId,
      ip: users.get(id)?.ip || 'unknown'
    }));
    return members;
  } catch (error) {
    console.error(`Error in getRoomMembers for room ${roomId}:`, error);
    return [];
  }
}

// 添加用户到房间的辅助函数
function addUserToRoom(socket, roomId, userId) {
  try {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
      console.log(`New room ${roomId} created`);
    }

    rooms.get(roomId).set(socket.id, { userId });
    users.set(socket.id, { userId, roomId });

    return true;
  } catch (error) {
    console.error(`Error adding user to room ${roomId}:`, error);
    return false;
  }
}

// 从房间移除用户的辅助函数
function removeUserFromRoom(socketId, roomId) {
  try {
    const room = rooms.get(roomId);
    if (room) {
      room.delete(socketId);
      if (room.size === 0) {
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted as it's empty`);
      }
    }
    users.delete(socketId);
  } catch (error) {
    console.error(`Error removing user from room:`, error);
  }
}

// 获取客户端真实IP的函数
function getClientIp(socket) {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || 
                  socket.handshake.address;
  return clientIp.replace(/^::ffff:/, ''); // 移除 IPv6 前缀
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
      users.set(socket.id, { 
        userId, 
        roomId,
        ip: clientIp
      });

      const members = getRoomMembers(roomId);

      // 发送加入成功消息给新用户
      socket.emit('room-joined', {
        roomId,
        members: members.map(member => ({
          ...member,
          ip: users.get(member.id)?.ip || 'unknown'
        }))
      });

      // 广播给所有用户更新后的用户列表
      io.in(roomId).emit('room-users-updated', members.map(member => ({
        ...member,
        ip: users.get(member.id)?.ip || 'unknown'
      })));

      // 通知其他用户有新用户加入
      socket.to(roomId).emit('user-connected', {
        id: socket.id,
        userId,
        ip: clientIp
      });
    } catch (error) {
      console.error('Error in join-room:', error);
      socket.emit('error', 'Internal server error');
    }
  });

  // 转发WebRTC信令
  socket.on('signal', ({ to, signal }) => {
    try {
      if (!to || !signal) {
        return socket.emit('error', 'Invalid signal data');
      }
      io.to(to).emit('signal', { from: socket.id, signal });
    } catch (error) {
      console.error('Error in signal:', error);
      socket.emit('error', 'Failed to send signal');
    }
  });

  // 处理连接状态变化
  socket.on('connection-state-change', ({ targetId, state, dataChannelState }) => {
    try {
      const user = users.get(socket.id);
      if (user && user.roomId) {
        io.in(user.roomId).emit('peer-connection-state', {
          fromId: socket.id,
          targetId,
          state,
          dataChannelState
        });
      }
    } catch (error) {
      console.error('Error in connection-state-change:', error);
    }
  });

  // 处理断开连接
  socket.on('disconnect', () => {
    try {
      console.log(`Disconnected: ${socket.id}`);
      const user = users.get(socket.id);
      if (user) {
        const { roomId } = user;
        const room = rooms.get(roomId);

        if (room) {
          // 从房间中移除用户
          removeUserFromRoom(socket.id, roomId);

          // 获取更新后的成员列表
          const members = getRoomMembers(roomId);

          // 通知房间内其他用户
          socket.to(roomId).emit('user-disconnected', socket.id);
          io.in(roomId).emit('room-users-updated', members);
        }
      }
    } catch (error) {
      console.error('Error in disconnect handler:', error);
    }
  });

  // 处理用户ID修改
  socket.on('change-user-id', ({ newId }) => {
    try {
      if (!newId || typeof newId !== 'string') {
        return socket.emit('user-id-changed', {
          success: false,
          error: '无效的用户ID'
        });
      }

      const user = users.get(socket.id);
      if (!user || !user.roomId) {
        return socket.emit('user-id-changed', {
          success: false,
          error: '用户未在房间中'
        });
      }

      // 更新用户信息
      const oldUserId = user.userId;
      user.userId = newId;
      users.set(socket.id, user);

      // 更新房间中的用户信息
      const room = rooms.get(user.roomId);
      if (room) {
        room.set(socket.id, { userId: newId });
      }

      // 发送成功响应
      socket.emit('user-id-changed', {
        success: true,
        userId: newId
      });

      // 广播用户列表更新
      const members = getRoomMembers(user.roomId);
      io.in(user.roomId).emit('room-users-updated', members.map(member => ({
        ...member,
        ip: users.get(member.id)?.ip || 'unknown'
      })));

      console.log(`用户ID已更改: ${oldUserId} -> ${newId}`);
    } catch (error) {
      console.error('修改用户ID时出错:', error);
      socket.emit('user-id-changed', {
        success: false,
        error: '修改用户ID失败'
      });
    }
  });
});

// 错误处理
io.on('error', (error) => {
  console.error('Socket.IO Error:', error);
});

// 优雅关闭处理
let isShuttingDown = false;

function cleanup() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('正在关闭服务器...');

  // 关闭所有 socket 连接
  io.sockets.sockets.forEach((socket) => {
    socket.disconnect(true);
  });

  // 清理数据
  rooms.clear();
  users.clear();

  // 关闭 HTTP 服务器
  server.close(() => {
    console.log('HTTP 服务器已关闭');
    process.exit(0);
  });

  // 设置超时强制退出
  setTimeout(() => {
    console.error('强制关闭服务器');
    process.exit(1);
  }, 5000);
}

// 监听进程信号
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGHUP', cleanup);

// 处理未捕获的异常
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
  cleanup();
});

// 处理未处理的 Promise 拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
  cleanup();
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});
