// WebRTC 配置
export const rtcConfig = {
    iceServers: [
        // STUN servers - 使用多个STUN服务器提高成功率
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
    rtcpMuxPolicy: 'require',
    // 启用ICE Lite以加快连接速度
    gatherPolicy: 'all',
    // 设置较短的ICE候选项超时时间，以便快速切换
    iceCandidateTimeout: 2000
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

// 新增连接优先级配置
export const ConnectionPriority = {
    HOST: 3,    // 本地连接优先级最高
    STUN: 2,    // STUN其次
    TURN: 1     // TURN最后
};

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