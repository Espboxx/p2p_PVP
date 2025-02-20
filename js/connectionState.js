// 连接状态常量
export const ConnectionState = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
  DISCONNECTED: 'disconnected'
};

// 存储连接重试次数和状态
export const connectionAttempts = new Map(); // key: peerId, value: { attempts: number, state: string }

// 更新连接状态的函数
export function updateConnectionState(peerId, state, { onlineUsers, updateUserList, displayMessage }) {
  let peerConnection = connectionAttempts.get(peerId) || { attempts: 0, state: ConnectionState.DISCONNECTED };
  
  // 如果状态没有变化，不更新
  if (peerConnection.state === state) {
    return;
  }
  
  const userInfo = onlineUsers.get(peerId);
  console.log(`更新用户 ${userInfo?.userId || '未知用户'} 的连接状态:`, state);
  
  peerConnection.state = state;
  
  if (state === ConnectionState.CONNECTING) {
    peerConnection.attempts++;
  }
  
  connectionAttempts.set(peerId, peerConnection);
  
  // 更新用户列表显示
  updateUserList([...onlineUsers.entries()].map(([id, userData]) => ({ 
    id, 
    userId: userData.userId,
    ip: userData.ip || 'unknown'
  })));
  
  // 添加系统消息
  let message;
  const userName = userInfo?.userId || '未知用户';
  switch (state) {
    case ConnectionState.CONNECTING:
      message = `正在与 ${userName} 建立连接...`;
      break;
    case ConnectionState.CONNECTED:
      message = `已与 ${userName} 建立连接`;
      break;
    case ConnectionState.FAILED:
      message = `与 ${userName} 的连接失败`;
      break;
    case ConnectionState.DISCONNECTED:
      message = `与 ${userName} 的连接已断开`;
      break;
  }
  
  if (message) {
    displayMessage(`系统: ${message}`, 'system');
  }
} 