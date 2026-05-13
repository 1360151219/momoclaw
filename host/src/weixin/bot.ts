import { WeixinGateway } from './gateway.js';
import type { UnifiedMessage } from './types.js';
import { processChat } from '../core/chatService.js';
import {
  getSession,
  createSession,
  getSessionByMapping,
  setWeixinMapping,
} from '../db/index.js';
import type { Session, ChannelContext } from '../types.js';
import { config } from '../config.js';
import { parseCommand } from '../utils/command.js';
import {
  executeCommand as coreExecuteCommand,
  type BaseCommandContext,
} from '../core/commands/executor.js';

export class WeixinBot {
  private gateway: WeixinGateway;
  private wxUserId: string;

  constructor(gateway: WeixinGateway, wxUserId: string) {
    this.gateway = gateway;
    this.wxUserId = wxUserId;
  }

  public async start(): Promise<void> {
    this.gateway.on('message', async (msg: UnifiedMessage) => {
      try {
        await this.handleMessage(msg);
      } catch (e) {
        console.error('[Weixin] Error handling message:', e);
      }
    });

    await this.gateway.start();
  }

  private getOrCreateSession(fromUserId: string): Session {
    const existingSessionId = getSessionByMapping(this.wxUserId, fromUserId);
    if (existingSessionId) {
      const session = getSession(existingSessionId);
      if (session) return session;
    }

    const sessionId = `wx_${this.wxUserId}_${fromUserId}`;
    let session = getSession(sessionId);
    if (!session) {
      session = createSession(
        sessionId,
        `Weixin Chat ${fromUserId}`,
        config.defaultSystemPrompt,
        undefined,
        this.wxUserId,
      );
    }

    setWeixinMapping(this.wxUserId, fromUserId, sessionId);
    return session;
  }

  private async handleMessage(msg: UnifiedMessage): Promise<void> {
    console.log('[Weixin] Received message Before Handle:', msg);
    const session = this.getOrCreateSession(msg.chatId);

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

    if (msg.chatId) {
      await this.gateway
        .getClient()
        .showTypingIndicator(msg.chatId, msg.contextToken);
    }

    let prompt = msg.text || '';
    if (msg.imageUrls && msg.imageUrls.length > 0) {
      prompt += `\n[Images uploaded: ${msg.imageUrls.join(', ')}]`;
    }

    const channelContext: ChannelContext = {
      type: 'weixin',
      channelId: msg.chatId,
      wxUserId: this.wxUserId,
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
        onToolEvent: (_event) => {
          // tool events handled by core
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
        await this.gateway
          .getClient()
          .sendTextMessage(msg.chatId, fullReply.trim(), currentToken);
      }

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
