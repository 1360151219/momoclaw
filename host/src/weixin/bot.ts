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

export interface WeixinBotOptions {
  weixinConfig: WeixinConfig;
}

export class WeixinBot {
  private gateway: WeixinGateway;

  constructor(options: WeixinBotOptions) {
    this.gateway = new WeixinGateway(options.weixinConfig);
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
      await processChat({
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

      if (fullReply.trim()) {
        // Get the latest context token from gateway store
        const currentToken =
          this.gateway.getContextToken(msg.chatId) || msg.contextToken;
        await this.gateway
          .getClient()
          .sendTextMessage(msg.chatId, fullReply.trim(), currentToken);

        // Hide typing indicator after sending reply
        await this.gateway
          .getClient()
          .hideTypingIndicator(msg.chatId, currentToken);
      }
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
