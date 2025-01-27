// WebRTC 配置
export const rtcConfig = {
    iceServers: [
        // STUN servers
        {
            urls: [
                'stun:stun.l.google.com:19302',
                'stun:stun1.l.google.com:19302',
                'stun:stun2.l.google.com:19302',
                'stun:stun3.l.google.com:19302',
                'stun:stun4.l.google.com:19302'
            ]
        },
        // TURN servers
        {
            urls: 'turn:107.175.213.234:3478',
            username: 'ddddd',

            credential: 'wdnmd12345'
        }
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all', // 允许所有传输策略
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};

// ICE 配置
export const iceConfig = {
    iceServers: rtcConfig.iceServers,
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 10
};

// 连接超时设置
export const CONNECTION_TIMEOUT = 20000; // 20 秒
export const ICE_GATHERING_TIMEOUT = 5000; // 5 秒
export const RECONNECT_DELAY = 2000; // 2 秒
export const MAX_RECONNECT_ATTEMPTS = 3;

// 文件传输配置
export const fileChunkSize = 16384; // 16KB

// 传输状态枚举
export const TransferState = {
    WAITING: 'waiting',
    TRANSFERRING: 'transferring',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
}; 