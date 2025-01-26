// 加密工具模块
export class CryptoHelper {
  constructor() {
    this.keyPair = null;
    this.sharedKeys = new Map(); // 存储与每个peer的共享密钥
    this.useSimpleEncryption = !window.crypto || !window.crypto.subtle;
    
    if (this.useSimpleEncryption) {
      console.warn('当前浏览器不支持 Web Crypto API，将使用基础加密方式');
    }
  }

  // 生成密钥对
  async generateKeyPair() {
    if (this.useSimpleEncryption) {
      // 使用简单的随机字符串作为密钥
      this.keyPair = {
        privateKey: this._generateSimpleKey(),
        publicKey: this._generateSimpleKey()
      };
      return this.keyPair;
    }

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
      console.warn('高级加密失败，切换到基础加密:', error);
      this.useSimpleEncryption = true;
      return this.generateKeyPair();
    }
  }

  // 导出公钥
  async exportPublicKey() {
    if (this.useSimpleEncryption) {
      return new TextEncoder().encode(this.keyPair.publicKey);
    }

    try {
      const exported = await window.crypto.subtle.exportKey(
        "spki",
        this.keyPair.publicKey
      );
      return new Uint8Array(exported);
    } catch (error) {
      console.warn('导出公钥失败，切换到基础加密:', error);
      this.useSimpleEncryption = true;
      return this.exportPublicKey();
    }
  }

  // 从二进制数据导入公钥
  async importPublicKey(keyData) {
    if (this.useSimpleEncryption) {
      return new TextDecoder().decode(keyData);
    }

    try {
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
    } catch (error) {
      console.warn('导入公钥失败，切换到基础加密:', error);
      this.useSimpleEncryption = true;
      return this.importPublicKey(keyData);
    }
  }

  // 生成共享密钥
  async deriveSharedKey(publicKey, peerId) {
    if (this.useSimpleEncryption) {
      // 使用简单的密钥组合方法
      const sharedKey = this._simpleKeyDerivation(
        this.keyPair.privateKey,
        publicKey
      );
      this.sharedKeys.set(peerId, sharedKey);
      return sharedKey;
    }

    try {
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
    } catch (error) {
      console.warn('生成共享密钥失败，切换到基础加密:', error);
      this.useSimpleEncryption = true;
      return this.deriveSharedKey(publicKey, peerId);
    }
  }

  // 加密数据
  async encrypt(data, peerId) {
    if (this.useSimpleEncryption) {
      const key = this.sharedKeys.get(peerId);
      if (!key) throw new Error("No shared key found for peer");
      
      const iv = this._generateSimpleKey(12);
      const encrypted = this._simpleEncrypt(JSON.stringify(data), key, iv);
      
      return {
        encrypted: new TextEncoder().encode(encrypted),
        iv: new TextEncoder().encode(iv)
      };
    }

    try {
      const sharedKey = this.sharedKeys.get(peerId);
      if (!sharedKey) throw new Error("No shared key found for peer");

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
    } catch (error) {
      console.warn('加密失败，切换到基础加密:', error);
      this.useSimpleEncryption = true;
      return this.encrypt(data, peerId);
    }
  }

  // 解密数据
  async decrypt(encryptedData, iv, peerId) {
    if (this.useSimpleEncryption) {
      const key = this.sharedKeys.get(peerId);
      if (!key) throw new Error("No shared key found for peer");
      
      const encryptedText = new TextDecoder().decode(encryptedData);
      const ivText = new TextDecoder().decode(iv);
      const decrypted = this._simpleDecrypt(encryptedText, key, ivText);
      
      return JSON.parse(decrypted);
    }

    try {
      const sharedKey = this.sharedKeys.get(peerId);
      if (!sharedKey) throw new Error("No shared key found for peer");

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
    } catch (error) {
      console.warn('解密失败，切换到基础加密:', error);
      this.useSimpleEncryption = true;
      return this.decrypt(encryptedData, iv, peerId);
    }
  }

  // 简单加密方法的辅助函数
  _generateSimpleKey(length = 32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  _simpleKeyDerivation(privateKey, publicKey) {
    // 简单的密钥组合方法
    return privateKey + publicKey;
  }

  _simpleEncrypt(text, key, iv) {
    // 一个非常基础的加密方法，仅用于降级方案
    let result = '';
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length) ^ iv.charCodeAt(i % iv.length);
      result += String.fromCharCode(charCode);
    }
    return btoa(result); // Base64 编码
  }

  _simpleDecrypt(encryptedText, key, iv) {
    // 对应的解密方法
    const text = atob(encryptedText); // Base64 解码
    let result = '';
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length) ^ iv.charCodeAt(i % iv.length);
      result += String.fromCharCode(charCode);
    }
    return result;
  }
}

export const cryptoHelper = new CryptoHelper();