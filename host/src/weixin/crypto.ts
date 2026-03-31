import crypto from 'crypto';
import type { ImageItem } from './types.js';

/**
 * AES-128-ECB 加密（带 PKCS7 填充）
 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true); // Node.js 默认就是 PKCS7
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * AES-128-ECB 解密（带 PKCS7 去除）
 */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 计算加密后的密文大小
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return (Math.floor((plaintextSize + 1) / 16) + 1) * 16;
}

/**
 * 解析 CDN 媒体的 aes_key
 *
 * 微信 CDN 的 aes_key 有两种编码格式：
 * 1. base64(16字节原始key)
 * 2. base64(32字符hex字符串)
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');

  if (decoded.length === 16) {
    return decoded;
  }

  if (decoded.length === 32) {
    const hexStr = decoded.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
      return Buffer.from(hexStr, 'hex');
    }
  }

  throw new Error(`Invalid aes_key format: got ${decoded.length} bytes`);
}

/**
 * 提取图片下载所需参数
 */
export function extractImageDownloadParams(imageItem: ImageItem): { encryptQueryParam: string, aesKey: Buffer } {
  const media = imageItem.media || {};
  const encryptQueryParam = media.encrypt_query_param;

  if (!encryptQueryParam) {
    throw new Error('Missing encrypt_query_param');
  }

  let aesKeyBase64 = '';
  // 优先使用 image_item.aeskey (hex 格式)
  if (imageItem.aeskey) {
    aesKeyBase64 = Buffer.from(Buffer.from(imageItem.aeskey, 'hex')).toString('base64');
  } else if (media.aes_key) {
    aesKeyBase64 = media.aes_key;
  } else {
    throw new Error('Missing aes_key in imageItem');
  }

  const aesKey = parseAesKey(aesKeyBase64);
  return { encryptQueryParam, aesKey };
}
