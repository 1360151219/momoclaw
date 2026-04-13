import { WeixinGateway } from './gateway.js';
import type { WeixinConfig, UnifiedMessage } from './types.js';
import { processChat } from '../core/chatService.js';
import { getSession, createSession } from '../db/index.js';
import type { Session, ChannelContext } from '../types.js';
import { config } from '../config.js';
import { parseCommand } from '../utils/command.js';
import {
  executeCommand as coreExecuteCommand,
  type BaseCommandContext,
} from '../core/commands/executor.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ensureDirWithPerms } from '../hooks/utils.js';

/**
 * 容器内的工作目录前缀（Docker 挂载点）
 * 对应 docker run 中: -v ${workspacePath}:/workspace/files:rw
 */
const CONTAINER_WORKSPACE_PREFIX = '/workspace/files';

/**
 * 将容器内路径转换为宿主机路径
 *
 * 背景：AI Agent 在 Docker 容器内运行，它生成的图片/文件路径是容器内路径
 * （如 /workspace/files/temp/downloads/xxx.png），但 Host 端在处理这些路径
 * 时需要用宿主机的实际路径才能读取文件。
 *
 * 映射关系（来自 container.ts 中的 docker run 参数）：
 *   容器内 /workspace/files  ←→  宿主机 config.workspaceDir
 */
function resolveContainerPath(filePath: string): string {
  if (filePath.startsWith(CONTAINER_WORKSPACE_PREFIX)) {
    const relativePath = filePath.slice(CONTAINER_WORKSPACE_PREFIX.length);
    return path.join(config.workspaceDir, relativePath);
  }
  // 如果是相对路径
  if (!filePath.startsWith('/')) {
    return path.resolve(config.workspaceDir, filePath);
  }
  return filePath;
}

export interface WeixinBotOptions {
  weixinConfig: WeixinConfig;
}

export class WeixinBot {
  private gateway: WeixinGateway;

  constructor(options: WeixinBotOptions) {
    this.gateway = new WeixinGateway(options.weixinConfig);
  }

  /**
   * 处理 Markdown 文本中的图片资源
   *
   * 从 AI Agent 的回复文本中提取所有 ![alt](path) 格式的图片引用，
   * 将容器内路径转换为宿主机路径，然后通过微信 CDN 上传并发送图片消息。
   * 发送完图片后，会从文本中移除图片标记，返回清理后的纯文本。
   *
   * @param text - AI Agent 回复的原始 Markdown 文本
   * @param userId - 目标用户 ID
   * @param contextToken - 会话上下文 token
   * @returns 清理掉图片标记后的纯文本
   */
  private async processMarkdownImages(
    text: string,
    userId: string,
    contextToken?: string,
  ): Promise<string> {
    // 匹配 Markdown 图片语法 ![alt](path)
    const imageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    const matches = [...text.matchAll(imageRegex)];

    if (matches.length === 0) return text;

    // 用于临时下载远程图片的目录
    const tempDir = path.resolve(config.workspaceDir, 'temp', 'wx-uploads');
    let processedText = text;

    for (const match of matches) {
      const originalString = match[0]; // 完整匹配：![alt](path)
      const imagePath = match[1]; // 图片路径

      if (!imagePath) {
        processedText = processedText.replace(originalString, '');
        continue;
      }

      try {
        let localPath: string;

        if (
          imagePath.startsWith('http://') ||
          imagePath.startsWith('https://')
        ) {
          // 远程图片：先下载到本地临时目录
          ensureDirWithPerms(tempDir);
          const ext = path.extname(new URL(imagePath).pathname) || '.jpg';
          const fileName = `remote_${Date.now()}${ext}`;
          localPath = path.join(tempDir, fileName);

          const response = await fetch(imagePath);
          if (!response.ok) {
            console.warn(
              `[Weixin] Failed to download remote image: ${imagePath}`,
            );
            processedText = processedText.replace(originalString, '');
            continue;
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(localPath, buffer);
        } else {
          // 本地/容器路径：转换为宿主机路径
          localPath = resolveContainerPath(imagePath);
        }

        if (!fs.existsSync(localPath)) {
          console.warn(
            `[Weixin] Image not found after path resolve: ${imagePath} -> ${localPath}`,
          );
          processedText = processedText.replace(originalString, '');
          continue;
        }

        // 上传并发送图片
        console.log(`[Weixin] Sending image: ${localPath}`);
        await this.gateway
          .getClient()
          .sendImageMessage(userId, localPath, contextToken);

        // 从文本中移除已发送的图片标记
        processedText = processedText.replace(originalString, '');
      } catch (err) {
        console.error(`[Weixin] Failed to process image ${imagePath}:`, err);
        processedText = processedText.replace(originalString, '');
      }
    }

    // 清理多余的空行（图片移除后可能留下很多空行）
    processedText = processedText.replace(/\n{3,}/g, '\n\n').trim();
    return processedText;
  }

  public async start() {
    this.gateway.on('message', async (msg: UnifiedMessage) => {
      try {
        await this.handleMessage(msg);
      } catch (e) {
        console.error('[Weixin] Error handling message:', e);
      }
    });

    await this.gateway.start();
  }

  private getOrCreateSession(chatId: string): Session {
    const sessionId = `wx_${chatId}`;
    let session = getSession(sessionId);
    if (!session) {
      session = createSession(
        sessionId,
        `Weixin Chat ${chatId}`,
        config.defaultModel,
      );
    }
    return session;
  }

  private async handleMessage(msg: UnifiedMessage) {
    console.log('[Weixin] Received message Before Handle:', msg);
    const session = this.getOrCreateSession(msg.chatId);

    // Support commands
    if (msg.text) {
      const cmd = parseCommand(msg.text);
      if (cmd) {
        const baseContext: BaseCommandContext = {
          channelId: msg.chatId,
          channelType: 'weixin',
          session: session,
        };
        const response = await coreExecuteCommand(cmd.command, baseContext);

        await this.gateway
          .getClient()
          .sendTextMessage(msg.chatId, response.text, msg.contextToken);
        return;
      }
    }

    // Show typing indicator
    if (msg.chatId) {
      await this.gateway
        .getClient()
        .showTypingIndicator(msg.chatId, msg.contextToken);
    }

    // Build user prompt
    let prompt = msg.text || '';
    if (msg.imageUrls && msg.imageUrls.length > 0) {
      // Append image references so Claude can read them via container file system
      prompt += `\n[Images uploaded: ${msg.imageUrls.join(', ')}]`;
    }

    const channelContext: ChannelContext = {
      type: 'weixin',
      channelId: msg.chatId,
    };

    let fullReply = '';
    console.log('[Weixin] start processChat:', prompt);
    try {
      const result = await processChat({
        content: prompt,
        session: session,
        channelContext,
        onChunk: (chunk) => {
          fullReply += chunk;
        },
        onToolEvent: (event) => {
          // Could notify user that bot is using tools, but omitting to keep it clean
        },
      });

      const currentToken =
        this.gateway.getContextToken(msg.chatId) || msg.contextToken;

      if (!result.success) {
        await this.gateway
          .getClient()
          .sendTextMessage(
            msg.chatId,
            `❌ Error: ${result.error || 'Unknown error'}`,
            currentToken,
          );
      } else if (fullReply.trim()) {
        // 先处理回复中的图片：提取、上传、发送，并返回清理后的纯文本
        const cleanedText = await this.processMarkdownImages(
          fullReply.trim(),
          msg.chatId,
          currentToken,
        );

        // 如果清理后还有文本内容，发送文本消息
        if (cleanedText.trim()) {
          await this.gateway
            .getClient()
            .sendTextMessage(msg.chatId, cleanedText.trim(), currentToken);
        }
      }

      // Hide typing indicator after sending reply
      await this.gateway
        .getClient()
        .hideTypingIndicator(msg.chatId, currentToken);
    } catch (error: any) {
      console.error('[Weixin] Unexpected error in chat flow:', error);
      const currentToken =
        this.gateway.getContextToken(msg.chatId) || msg.contextToken;
      await this.gateway
        .getClient()
        .sendTextMessage(
          msg.chatId,
          `❌ Unexpected error: ${error.message}`,
          currentToken,
        );
    }
  }
}

export async function startWeixinBot(options: WeixinBotOptions): Promise<void> {
  const bot = new WeixinBot(options);
  await bot.start();
}
