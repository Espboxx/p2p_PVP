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
        // 添加更多公共STUN服务器
        {
            urls: [
                'stun:stun.stunprotocol.org:3478',
                'stun:stun.voip.blackberry.com:3478',
                'stun:stun.schlund.de:3478'
            ]
        }
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    sdpSemantics: 'unified-plan',
    // 启用trickle ICE以加快连接速度
    iceTransports: 'all',
    // 优化音视频设置
    encodedInsertableStreams: true, // 启用E2EE支持
    // 优化带宽使用
    offerExtmapAllowMixed: true
};

// ICE 配置
export const iceConfig = {
    iceServers: rtcConfig.iceServers,
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 10,
    // 添加ICE性能优化选项
    gatherPolicy: 'all',
    iceServersTimeout: 3000, // 3秒超时
    iceBackupPairs: true, // 启用备用ICE候选对
    // 添加TURN服务器故障转移支持
    turnServersBackup: true
};

// 连接超时设置
export const CONNECTION_TIMEOUT = 30000; // 30 秒，增加以处理慢速网络
export const ICE_GATHERING_TIMEOUT = 8000; // 8 秒，增加以收集更多候选项
export const RECONNECT_DELAY = 3000; // 3 秒，增加以避免过于频繁的重连
export const MAX_RECONNECT_ATTEMPTS = 5; // 增加重连尝试次数

// 连接优先级配置
export const ConnectionPriority = {
    HOST: 3,    // 本地连接优先级最高
    SRFLX: 2,   // Server Reflexive (STUN)
    PRFLX: 1,   // Peer Reflexive
    RELAY: 0    // TURN中继
};

// 文件传输配置
export const FILE_CONFIG = {
    chunkSize: 16384, // 16KB 块大小
    maxFileSize: 2147483648, // 最大文件大小 (2GB)
    supportedTypes: '*', // 支持所有文件类型
    // 传输速率限制 (bytes/second)
    maxUploadRate: 1048576, // 1MB/s
    maxDownloadRate: 1048576, // 1MB/s
    // 并发传输限制
    maxConcurrentTransfers: 3
};

// 传输状态枚举
export const TransferState = {
    WAITING: 'waiting',
    PREPARING: 'preparing',
    TRANSFERRING: 'transferring',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
};

// 数据通道配置
export const DATA_CHANNEL_CONFIG = {
    ordered: true,
    maxRetransmits: 3,
    maxPacketLifeTime: 3000,
    // 优化数据通道性能
    protocol: 'sctp',
    negotiated: true,
    id: 0,
    priority: 'high'
};

// 连接状态检查配置
export const HEALTH_CHECK_CONFIG = {
    interval: 5000, // 每5秒检查一次
    timeout: 2000, // 2秒超时
    maxMissedChecks: 3 // 允许最多错过3次检查
};

// 媒体流配置
export const MEDIA_CONFIG = {
    audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 2,
        sampleRate: 48000,
        sampleSize: 16
    },
    video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
        facingMode: 'user'
    }
}; 