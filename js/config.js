// WebRTC配置
export const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ]
};

// 文件传输配置
export const fileChunkSize = 16 * 1024; // 16KB分块

// 传输状态常量
export const TransferState = {
  WAITING: 'waiting',    // 等待接收方确认
  TRANSFERRING: 'transferring', // 正在传输
  PAUSED: 'paused',     // 传输暂停（断开时）
  COMPLETED: 'completed', // 传输完成
  FAILED: 'failed'      // 传输失败
}; 