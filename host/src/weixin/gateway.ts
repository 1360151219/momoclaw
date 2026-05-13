import { EventEmitter } from 'events';
import { WeixinClient } from './client.js';
import type { WeixinConfig, WeixinMessage, UnifiedMessage } from './types.js';
import { extractImageDownloadParams, decryptAesEcb } from './crypto.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ensureDirWithPerms } from '../hooks/utils.js';

export class WeixinGateway extends EventEmitter {
  private client: WeixinClient;
  private wxUserId: string | null = null;
  private isRunning: boolean = false;
  private getUpdatesBuf: string = '';
  private contextTokenStore: Map<string, string> = new Map();
  private cdnBaseUrl: string;
  private workspaceDir: string = '';

  constructor(config: WeixinConfig) {
    super();
    this.client = new WeixinClient(config);
    this.cdnBaseUrl = config.cdnBaseUrl;
  }

  public getClient(): WeixinClient {
    return this.client;
  }

  public getWxUserId(): string | null {
    return this.wxUserId;
  }

  /** Set the wxUserId (ilink_user_id from WeChat) and isolate the temp dir. */
  public setWxUserId(id: string): void {
    this.wxUserId = id;
    this.workspaceDir = path.resolve(process.cwd(), './workspace', id, 'temp');
    if (!fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
  }

  public getContextToken(userId: string): string | undefined {
    return this.contextTokenStore.get(userId);
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      if (this.client.hasToken()) {
        console.log('[Weixin] Using existing token, skipping QR code login.');
      } else {
        await this.client.loginWithQrcode();
      }

      this.isRunning = true;
      console.log('[Weixin] Gateway started, polling for messages...');
      this.pollLoop();
    } catch (e) {
      console.error('[Weixin] Failed to start gateway:', e);
      throw e;
    }
  }

  public stop(): void {
    this.isRunning = false;
  }

  private async pollLoop() {
    while (this.isRunning) {
      try {
        const res = await this.client.getUpdates(this.getUpdatesBuf);

        if (res.ret === -14) {
          console.error(
            '[Weixin] Session expired. Please restart the bot to scan QR code again.',
          );
          this.isRunning = false;
          break;
        }

        if (res.get_updates_buf) {
          this.getUpdatesBuf = res.get_updates_buf;
        }

        if (res.msgs && res.msgs.length > 0) {
          for (const msg of res.msgs) {
            await this.handleMessage(msg);
          }
        }
      } catch (e) {
        console.error('[Weixin] Polling error:', e);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private async handleMessage(msg: WeixinMessage) {
    if (msg.message_type !== 1) return;
    if (!msg.from_user_id || !msg.item_list) return;

    if (msg.context_token) {
      this.contextTokenStore.set(msg.from_user_id, msg.context_token);
    }

    const unifiedMsg: UnifiedMessage = {
      chatId: msg.from_user_id,
      ilink_user_id: this.client.ilink_user_id,
      messageId: msg.message_id?.toString() || Date.now().toString(),
      contextToken: msg.context_token || '',
      imageUrls: [],
    };

    let textParts: string[] = [];

    for (const item of msg.item_list) {
      if (item.type === 1 && item.text_item) {
        textParts.push(item.text_item.text);
      } else if (item.type === 2 && item.image_item) {
        try {
          const { encryptQueryParam, aesKey } = extractImageDownloadParams(
            item.image_item,
          );
          const downloadUrl = `${this.cdnBaseUrl.replace(/\/$/, '')}?${encryptQueryParam}`;

          const resp = await fetch(downloadUrl);
          if (!resp.ok) throw new Error(`CDN Download failed: ${resp.status}`);

          const encryptedBuf = Buffer.from(await resp.arrayBuffer());
          const decryptedBuf = decryptAesEcb(encryptedBuf, aesKey);

          const filename = `wx_img_${crypto.randomBytes(4).toString('hex')}.jpg`;
          const localPath = path.join(this.workspaceDir, filename);
          fs.writeFileSync(localPath, decryptedBuf);

          const containerPath = `/workspace/temp/${filename}`;
          unifiedMsg.imageUrls!.push(containerPath);
        } catch (err) {
          console.error('[Weixin] Failed to process image:', err);
        }
      }
    }

    unifiedMsg.text = textParts.join('\n').trim();

    if (
      !unifiedMsg.text &&
      (!unifiedMsg.imageUrls || unifiedMsg.imageUrls.length === 0)
    ) {
      return;
    }

    this.emit('message', unifiedMsg);
  }
}
