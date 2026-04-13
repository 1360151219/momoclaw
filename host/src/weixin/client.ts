import crypto from 'crypto';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { ensureDirWithPerms } from '../hooks/utils.js';
import type {
  WeixinConfig,
  GetUpdatesResponse,
  TypingStatus,
  BotTokenInfo,
  MessageItem,
  GetUploadUrlResponse,
  UploadMediaResult,
} from './types.js';
import { UploadMediaType, MessageItemType } from './types.js';
import {
  generateAesKey,
  encryptAesEcb,
  encodeAesKeyHex,
  encodeAesKeyBase64,
} from './crypto.js';

const WECHAT_QR_BOT_TYPE = 3;
const TOKEN_FILE_PATH = path.resolve(
  process.env.WORKSPACE_DIR || './workspace',
  'credentials',
  '.wx_token.json',
);

export class WeixinClient {
  private config: WeixinConfig;
  private bot_token: string | null = null;
  private baseUrl: string | null = null;
  private ilink_bot_id: string | null = null;
  public ilink_user_id?: string;
  private wechatUin: string;

  constructor(config: WeixinConfig) {
    this.config = config;
    this.wechatUin = this.randomWechatUin();
  }

  public setToken(tokenInfo: BotTokenInfo) {
    this.bot_token = tokenInfo.bot_token!;
    this.baseUrl = tokenInfo.baseurl!;
    this.ilink_bot_id = tokenInfo.ilink_bot_id!;
    this.ilink_user_id = tokenInfo.ilink_user_id!;

    // Save token to local file
    try {
      ensureDirWithPerms(path.dirname(TOKEN_FILE_PATH));
      fs.writeFileSync(
        TOKEN_FILE_PATH,
        JSON.stringify(tokenInfo, null, 2),
        'utf-8',
      );
    } catch (e) {
      console.error('[Weixin] Failed to save token to local file:', e);
    }
  }

  public loadLocalToken(): boolean {
    try {
      if (fs.existsSync(TOKEN_FILE_PATH)) {
        const data = fs.readFileSync(TOKEN_FILE_PATH, 'utf-8');
        const tokenInfo = JSON.parse(data) as BotTokenInfo;
        if (tokenInfo && tokenInfo.bot_token) {
          this.setToken(tokenInfo);
          return true;
        }
      }
    } catch (e) {
      console.error('[Weixin] Failed to load local token:', e);
    }
    return false;
  }

  private randomWechatUin(): string {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(uint32.toString()).toString('base64');
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': this.wechatUin,
    };
    if (this.bot_token) {
      headers['Authorization'] = `Bearer ${this.bot_token}`;
    }
    return headers;
  }

  private buildBaseInfo(version: string = '2.0.1') {
    return { channel_version: version };
  }

  private async request(
    endpoint: string,
    payload: any,
    method: string = 'POST',
  ): Promise<any> {
    // 处理带 query 参数的 endpoint，确保 URL 拼接正确
    const separator = endpoint.startsWith('/') ? '' : '/';
    const url = `${this.config.baseUrl.replace(/\/$/, '')}${separator}${endpoint}`;

    // Some endpoints are GET, but we mostly use POST with JSON body
    const init: RequestInit = {
      method,
      headers: this.buildHeaders(),
    };

    if (method !== 'GET') {
      init.body = JSON.stringify({
        ...payload,
        base_info: this.buildBaseInfo(),
      });
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      init.signal = controller.signal;

      const resp = await fetch(url, init);
      clearTimeout(timeoutId);

      if (!resp.ok) {
        throw new Error(
          `Weixin API Error: ${resp.status} ${resp.statusText} at ${endpoint}`,
        );
      }
      const res = await resp.json();
      if (res.ret !== 0 && res.ret !== undefined) {
        throw new Error(
          `Weixin API Error in payload: ret=${res.ret}, errmsg=${res.errmsg} at ${endpoint}`,
        );
      }
      console.log('[Weixin] request success, url:', url, '\n res:', res);
      return res;
    } catch (error: any) {
      // 添加详细的网络错误日志，帮助排查是否是域名或网络不通
      console.error(`[Weixin] Fetch error at ${url}:`, error.message);
      throw error;
    }
  }

  // Auth / Login flow
  public async getBotQrcode(): Promise<{
    qrcode?: string;
    qrcode_img_content?: string;
  }> {
    return this.request(
      `/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WECHAT_QR_BOT_TYPE)}`,
      {},
      'GET',
    );
  }

  public async getQrcodeStatus(qrcode: string): Promise<BotTokenInfo> {
    return this.request(
      `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      {},
      'GET',
    );
  }

  public async _getQrcodeStatusPoll(qrcode: string): Promise<BotTokenInfo> {
    try {
      const statusRes = await this.getQrcodeStatus(qrcode);
      console.error('[Weixin] Get qrcode status:', statusRes.status);
      if (statusRes.ret === 0 && statusRes.status === 'confirmed') {
        console.log('[Weixin] Login successful!');
        this.setToken(statusRes);
        return statusRes;
      } else {
        // Wait 2 seconds before polling again to avoid spamming the API
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return this._getQrcodeStatusPoll(qrcode);
      }
    } catch (e: any) {
      // ignore network errors during polling, keep trying
      console.error('[Weixin] Get qrcode status error:', e);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return this._getQrcodeStatusPoll(qrcode);
    }
  }

  public async loginWithQrcode(): Promise<BotTokenInfo> {
    console.log('[Weixin] Requesting login QR Code...');
    const qrRes = await this.getBotQrcode();
    if (!qrRes.qrcode_img_content || !qrRes.qrcode) {
      throw new Error(
        `Failed to get QR code：${JSON.stringify(qrRes, null, 2)}`,
      );
    }
    console.log('[Weixin] Please scan the QR code to login:');
    qrcode.generate(qrRes.qrcode_img_content, { small: true });
    console.log('[Weixin] Waiting for scan...');
    return this._getQrcodeStatusPoll(qrRes.qrcode);
  }

  // Messaging API
  public async getUpdates(
    getUpdatesBuf: string = '',
    timeoutMs: number = 35000,
  ): Promise<GetUpdatesResponse> {
    try {
      // Create a custom fetch just for long polling timeout
      const url = `${this.config.baseUrl.replace(/\/$/, '')}/ilink/bot/getupdates`;
      const controller = new AbortController();
      // Wait slightly longer than the requested timeoutMs
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs + 5000);

      const payload = {
        get_updates_buf: getUpdatesBuf,
        base_info: this.buildBaseInfo(),
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        throw new Error(`Weixin getUpdates Error: ${resp.status}`);
      }
      return (await resp.json()) as GetUpdatesResponse;
    } catch (error: any) {
      if (error.name === 'AbortError' || error.message.includes('Timeout')) {
        // Normal long polling timeout
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
      }
      throw error;
    }
  }

  private generateClientId(): string {
    return `openclaw-wx-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  public async sendMessage(
    toUserId: string,
    itemList: MessageItem[],
    contextToken?: string,
  ): Promise<any> {
    const payload = {
      msg: {
        from_user_id: '', // Bot sending, leave empty
        to_user_id: toUserId,
        client_id: this.generateClientId(),
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: itemList,
      },
    };
    return this.request('/ilink/bot/sendmessage', payload, 'POST');
  }

  public async sendTextMessage(
    toUserId: string,
    text: string,
    contextToken?: string,
  ): Promise<any> {
    const chars = Array.from(text);
    const limit = 2000;
    const chunks: string[] = [];

    for (let index = 0; index < chars.length; index += limit) {
      chunks.push(chars.slice(index, index + limit).join(''));
    }

    if (chunks.length === 0) chunks.push('');

    let lastResult;
    for (const chunk of chunks) {
      lastResult = await this.sendMessage(
        toUserId,
        [
          {
            type: 1, // TEXT
            text_item: { text: chunk },
          },
        ],
        contextToken,
      );
    }
    return lastResult;
  }

  public async getConfig(
    ilinkUserId: string,
    contextToken?: string,
  ): Promise<any> {
    return this.request(
      '/ilink/bot/getconfig',
      {
        ilink_user_id: ilinkUserId,
        context_token: contextToken,
      },
      'POST',
    );
  }

  public async sendTyping(
    ilinkUserId: string,
    typingTicket: string,
    status: TypingStatus = 1,
  ): Promise<any> {
    return this.request(
      '/ilink/bot/sendtyping',
      {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
      },
      'POST',
    );
  }

  public async showTypingIndicator(userId: string, contextToken?: string) {
    try {
      const configRes = await this.getConfig(userId, contextToken);
      if (configRes.typing_ticket) {
        await this.sendTyping(userId, configRes.typing_ticket, 1);
      }
    } catch (e) {
      console.error('[Weixin] Failed to send typing indicator:', e);
    }
  }

  public async hideTypingIndicator(userId: string, contextToken?: string) {
    try {
      const configRes = await this.getConfig(userId, contextToken);
      if (configRes.typing_ticket) {
        await this.sendTyping(userId, configRes.typing_ticket, 2);
      }
    } catch (e) {
      console.error('[Weixin] Failed to hide typing indicator:', e);
    }
  }

  /**
   * 向微信服务器请求文件上传地址
   *
   * 这是微信 CDN 上传的第一步：
   *   1. 调用 getuploadurl 获取上传地址  ← 这个方法
   *   2. 将加密后的文件 POST 到 CDN
   *   3. 获取返回的 encrypt_query_param 用于构建消息
   */
  public async getUploadUrl(params: {
    filekey: string;
    media_type: UploadMediaType;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    no_need_thumb?: boolean;
    aeskey?: string;
  }): Promise<GetUploadUrlResponse> {
    return this.request('/ilink/bot/getuploadurl', params, 'POST');
  }

  /**
   * 上传本地文件到微信 CDN
   *
   * 完整流程：
   *   1. 读取文件 → 生成 AES key → 加密文件内容
   *   2. 调用 getuploadurl 获取上传地址
   *   3. 将加密数据 POST 到 CDN 上传地址
   *   4. 从响应头获取 x-encrypted-param，构建 CDNMedia 对象
   *
   * @param filePath - 本地文件路径（宿主机路径）
   * @param userId - 目标用户 ID
   * @param mediaType - 媒体类型（IMAGE=1, VIDEO=2, FILE=3, VOICE=4）
   * @returns CDNMedia 引用，可用于构建图片/文件消息
   */
  public async uploadMedia(
    filePath: string,
    userId: string,
    mediaType: UploadMediaType = UploadMediaType.IMAGE,
  ): Promise<UploadMediaResult> {
    const fileData = fs.readFileSync(filePath);

    // 1. 生成 AES key 并加密文件
    const aesKey = generateAesKey();
    const ciphertext = encryptAesEcb(fileData, aesKey);
    const filekey = crypto.randomBytes(16).toString('hex');
    const rawMd5 = crypto.createHash('md5').update(fileData).digest('hex');

    console.log('[Weixin] Uploading media:', {
      rawSize: fileData.length,
      encryptedSize: ciphertext.length,
      filekey,
      mediaType,
    });

    // 2. 获取上传地址
    const uploadParams = await this.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: userId,
      rawsize: fileData.length,
      rawfilemd5: rawMd5,
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: encodeAesKeyHex(aesKey),
    });

    // 构建上传 URL：优先使用 upload_full_url，回退到手动拼接
    const cdnBaseUrl = this.config.cdnBaseUrl.replace(/\/$/, '');
    const uploadUrl =
      uploadParams.upload_full_url?.trim() ||
      `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParams.upload_param)}&filekey=${encodeURIComponent(filekey)}`;

    // 3. 将加密数据 POST 到 CDN（最多重试 3 次）
    let encryptQueryParam: string | undefined;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status >= 400 && response.status < 500) {
          const errMsg =
            response.headers.get('x-error-message') ??
            `HTTP ${response.status}`;
          throw new Error(
            `CDN upload client error ${response.status}: ${errMsg}`,
          );
        }

        if (!response.ok) {
          throw new Error(`CDN upload server error: HTTP ${response.status}`);
        }

        encryptQueryParam =
          response.headers.get('x-encrypted-param') ?? undefined;
        if (!encryptQueryParam) {
          throw new Error(
            'CDN upload response missing x-encrypted-param header',
          );
        }

        console.log(`[Weixin] CDN upload success, attempt=${attempt}`);
        break;
      } catch (err: any) {
        // 4xx 错误不重试
        if (err.message?.includes('client error')) throw err;
        if (attempt < MAX_RETRIES) {
          console.warn(
            `[Weixin] CDN upload attempt ${attempt} failed, retrying...`,
            err.message,
          );
        } else {
          throw new Error(
            `CDN upload failed after ${MAX_RETRIES} attempts: ${err.message}`,
          );
        }
      }
    }

    return {
      media: {
        encrypt_query_param: encryptQueryParam!,
        aes_key: encodeAesKeyBase64(aesKey),
        encrypt_type: 1,
      },
      aesKey,
      encryptedFileSize: ciphertext.length,
    };
  }

  /**
   * 发送图片消息给用户
   *
   * 高层方法：自动完成 上传 → 构建消息 → 发送 的全部流程
   *
   * @param toUserId - 目标用户 ID
   * @param filePath - 本地图片文件路径
   * @param contextToken - 会话上下文 token（从用户消息中获取）
   */
  public async sendImageMessage(
    toUserId: string,
    filePath: string,
    contextToken?: string,
  ): Promise<any> {
    // 1. 上传图片到 CDN
    const uploadResult = await this.uploadMedia(
      filePath,
      toUserId,
      UploadMediaType.IMAGE,
    );

    // 2. 获取原始文件大小作为 mid_size
    const stat = fs.statSync(filePath);

    // 3. 构建并发送图片消息
    return this.sendMessage(
      toUserId,
      [
        {
          type: MessageItemType.IMAGE,
          image_item: {
            media: uploadResult.media,
            mid_size: stat.size,
          },
        },
      ],
      contextToken,
    );
  }
}
