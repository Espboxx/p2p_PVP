// WebRTC 配置
export const rtcConfig = {
    iceServers: [
        // STUN servers - 使用更稳定的STUN服务器
        {
            urls: [
                'stun:stun.voipbuster.com:3478',
                'stun:stun.voipstunt.com:3478',
                'stun:stun.internetcalls.com:3478',
                'stun:stun.voip.aebc.com:3478',
                // 保留一些Google的STUN服务器作为备用
                'stun:stun.l.google.com:19302',
                'stun:stun1.l.google.com:19302'
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
    iceServersTimeout: 5000, // 增加到5秒
    iceBackupPairs: true, // 启用备用ICE候选对
    // 添加TURN服务器故障转移支持
    turnServersBackup: true
};

// 连接超时设置
export const CONNECTION_TIMEOUT = 45000; // 增加到45秒
export const ICE_GATHERING_TIMEOUT = 12000; // 增加到12秒
export const RECONNECT_DELAY = 5000; // 增加到5秒
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
    maxRetransmits: 5, // 增加重传次数
    // 优化数据通道性能
    protocol: 'sctp',
    negotiated: true,
    id: 0,
    priority: 'high'
};

// 连接状态检查配置
export const HEALTH_CHECK_CONFIG = {
    interval: 3000, // 减少到3秒以更快检测问题
    timeout: 2000,
    maxMissedChecks: 3
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