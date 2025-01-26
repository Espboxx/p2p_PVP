// 加密工具模块
export class CryptoHelper {
  constructor() {
    // 检查浏览器是否支持 Web Crypto API
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('当前浏览器不支持 Web Crypto API，请使用最新版本的 Chrome、Firefox、Safari 或 Edge');
    }
    
    this.keyPair = null;
    this.sharedKeys = new Map(); // 存储与每个peer的共享密钥
  }

  // 生成密钥对
  async generateKeyPair() {
    try {
      this.keyPair = await window.crypto.subtle.generateKey(
        {
          name: "ECDH",
          namedCurve: "P-256"
        },
        true,
        ["deriveKey", "deriveBits"]
      );
      return this.keyPair;
    } catch (error) {
      console.error('生成密钥对失败:', error);
      throw new Error('生成密钥对失败，请检查浏览器设置或使用其他现代浏览器');
    }
  }

  // 导出公钥
  async exportPublicKey() {
    const exported = await window.crypto.subtle.exportKey(
      "spki",
      this.keyPair.publicKey
    );
    return new Uint8Array(exported);
  }

  // 从二进制数据导入公钥
  async importPublicKey(keyData) {
    return await window.crypto.subtle.importKey(
      "spki",
      keyData,
      {
        name: "ECDH",
        namedCurve: "P-256"
      },
      true,
      []
    );
  }

  // 生成共享密钥
  async deriveSharedKey(publicKey, peerId) {
    const sharedKey = await window.crypto.subtle.deriveKey(
      {
        name: "ECDH",
        public: publicKey
      },
      this.keyPair.privateKey,
      {
        name: "AES-GCM",
        length: 256
      },
      true,
      ["encrypt", "decrypt"]
    );
    this.sharedKeys.set(peerId, sharedKey);
    return sharedKey;
  }

  // 加密数据
  async encrypt(data, peerId) {
    const sharedKey = this.sharedKeys.get(peerId);
    if (!sharedKey) {
      throw new Error("No shared key found for peer");
    }

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(data));

    const encrypted = await window.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv
      },
      sharedKey,
      encoded
    );

    return {
      encrypted: new Uint8Array(encrypted),
      iv: iv
    };
  }

  // 解密数据
  async decrypt(encryptedData, iv, peerId) {
    const sharedKey = this.sharedKeys.get(peerId);
    if (!sharedKey) {
      throw new Error("No shared key found for peer");
    }

    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv
      },
      sharedKey,
      encryptedData
    );

    const decoded = new TextDecoder().decode(decrypted);
    return JSON.parse(decoded);
  }
}

export const cryptoHelper = new CryptoHelper();