const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 配置静态文件服务
app.use(express.static(__dirname));

// 房间存储结构 {房间号: {客户端ID: 用户信息}}
const rooms = new Map();

// 用户信息存储 {socketId: {userId, roomId}}
const users = new Map();

// 添加一个辅助函数来获取房间成员列表
function getRoomMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const members = Array.from(room.entries()).map(([id, user]) => ({
    id,
    userId: user.userId
  }));
  console.log(`getRoomMembers for roomId ${roomId}:`, members); // 调试日志
  return members;
}

// 信令服务器逻辑
io.on('connection', (socket) => {
  console.log(`新连接: ${socket.id}`);

  // 加入房间处理
  socket.on('join-room', (roomId) => {
    if (!roomId) {
      console.log(`socket ${socket.id} 试图加入没有房间号的房间`);
      return socket.emit('error', '房间号不能为空');
    }

    // 获取用户ID
    const userId = socket.handshake.query.userId;
    console.log(`socket ${socket.id} 请求加入房间 ${roomId}，用户ID: ${userId}`);

    if (!userId) {
      console.log(`socket ${socket.id} 没有提供有效的 userId`);
      return socket.emit('error', '用户ID不能为空');
    }

    // 离开之前的房间
    if (socket.room) {
      socket.leave(socket.room);
      rooms.get(socket.room)?.delete(socket.id);
      console.log(`socket ${socket.id} 离开了之前的房间 ${socket.room}`);
    }

    // 存储用户信息
    users.set(socket.id, { userId, roomId });

    socket.join(roomId);
    socket.room = roomId;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
      console.log(`新房间 ${roomId} 已创建`);
    }

    // 存储用户信息到房间
    rooms.get(roomId).set(socket.id, { userId });

    console.log(`用户 ${userId} (${socket.id}) 加入房间 ${roomId}`);

    // 获取最新的成员列表
    const members = getRoomMembers(roomId);
    console.log('当前房间成员:', members); // 调试日志

    // 先发送加入成功消息给新用户
    socket.emit('room-joined', {
      roomId,
      members
    });

    // 然后广播给所有用户（包括新用户）更新后的用户列表
    io.in(roomId).emit('room-users-updated', members);

    // 最后通知其他用户有新用户加入
    socket.to(roomId).emit('user-connected', {
      id: socket.id,
      userId
    });
  });

  // 转发WebRTC信令
  socket.on('signal', ({ to, signal }) => {
    console.log(`socket ${socket.id} 转发信令到 socket ${to}`);
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  // 处理断开连接
  socket.on('disconnect', () => {
    console.log(`断开连接: ${socket.id}`);
    const user = users.get(socket.id);
    if (user) {
      const { roomId } = user;
      const room = rooms.get(roomId);

      if (room) {
        // 从房间中移除用户
        room.delete(socket.id);
        console.log(`用户 ${user.userId} (${socket.id}) 已从房间 ${roomId} 移除`);

        // 获取更新后的成员列表
        const members = getRoomMembers(roomId);
        console.log('断开连接后房间成员:', members); // 调试日志

        // 先通知房间内其他用户有用户断开连接
        socket.to(roomId).emit('user-disconnected', socket.id);

        // 然后广播更新后的用户列表
        io.in(roomId).emit('room-users-updated', members);

        // 如果房间为空，删除房间
        if (room.size === 0) {
          rooms.delete(roomId);
          console.log(`房间 ${roomId} 已删除，因为没有成员了`);
        }
      }
      // 从用户列表中移除
      users.delete(socket.id);
    }
  });

  socket.on('connection-state-change', ({ targetId, state, dataChannelState }) => {
    const user = users.get(socket.id);
    if (user && user.roomId) {
      // 向房间内所有用户广播连接状态变化
      io.in(user.roomId).emit('peer-connection-state', {
        fromId: socket.id,
        targetId,
        state,
        dataChannelState
      });
    }
  });
});

server.listen(3000, () => {
  console.log('信令服务器运行在 http://localhost:3000');
});
