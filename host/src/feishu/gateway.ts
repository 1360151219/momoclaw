/**
 * Feishu Gateway - Main entry point using official SDK
 * Uses @larksuiteoapi/node-sdk for WebSocket and event handling
 */

import type * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuSender, STREAM_EL } from './sender.js';
import { logger } from './logger.js';
import type {
  FeishuConfig,
  FeishuMessage,
  MessageHandler,
  FeishuResponse,
} from './types.js';
import type { RawMessageEvent } from './client.js';
import {
  getWsClient,
  getEventDispatcher,
  fetchBotInfo,
  toCredentials,
} from './client.js';
import { parseMessage, isSlashCommand } from './receiver.js';
import {
  getSession,
  createSession,
  clearSessionMessages,
  listSessions,
  deleteSession,
  getSessionMessages,
  getMapping,
  setMapping,
  deleteMapping,
  listMappings,
} from '../db/index.js';
import type { Session } from '../types.js';

const log = logger('feishu:gateway');

export interface GatewayOptions {
  onMessage?: MessageHandler;
  onStream?: StreamHandler;
}

export type StreamHandler = (
  message: FeishuMessage,
  updater: StreamUpdater,
) => Promise<void>;

export interface StreamUpdater {
  updateThinking: (text: string) => Promise<void>;
  updateContent: (text: string) => Promise<void>;
  appendToolUse: (name: string, input: unknown) => Promise<void>;
  finalize: (response: FeishuResponse) => Promise<void>;
}

export class FeishuGateway {
  private sender: FeishuSender;
  private wsClient?: Lark.WSClient;
  private botOpenId?: string;
  private isRunning = false;
  private activeReactions = new Map<string, string>();
  // In-memory cache for chat-to-session mapping (reduces DB queries)
  private sessionCache = new Map<string, string>();

  constructor(private config: FeishuConfig) {
    this.sender = new FeishuSender(config);
  }

  /**
   * Warm up session cache from persistent storage on startup
   */
  private warmupCache(): void {
    try {
      const mappings = listMappings();
      for (const mapping of mappings) {
        this.sessionCache.set(mapping.chatId, mapping.sessionId);
      }
      log.info(`Cache warmed up with ${mappings.length} session mappings`);
    } catch (err) {
      log.warn(`Failed to warm up cache: ${err}`);
    }
  }

  async start(options: GatewayOptions): Promise<void> {
    if (this.isRunning) {
      log.warn('Gateway already running');
      return;
    }

    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('Feishu gateway: appId and appSecret are required');
    }

    this.isRunning = true;
    log.info('Starting Feishu gateway with official SDK...');

    // Warm up session cache from database
    this.warmupCache();

    // Fetch bot info
    const botInfo = await fetchBotInfo(toCredentials(this.config));
    if (botInfo.ok && botInfo.botOpenId) {
      this.botOpenId = botInfo.botOpenId;
      log.info(
        `Bot connected: ${botInfo.botName || 'unknown'} (${this.botOpenId})`,
      );
    }

    // Setup event dispatcher
    const dispatcher = getEventDispatcher({
      verificationToken: this.config.verificationToken,
      encryptKey: this.config.encryptKey,
    });

    // Register event handlers
    dispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        if (!this.isRunning) return;
        try {
          await this.handleMessageEvent(data as RawMessageEvent, options);
        } catch (err) {
          log.error(`Error handling message: ${err}`);
        }
      },
      'im.message.message_read_v1': async () => {
        // Acknowledge read receipts
      },
      'im.chat.member.bot.added_v1': async (data: unknown) => {
        const chatId = (data as Record<string, string>)['chat_id'];
        log.info(`Bot added to chat: ${chatId}`);
      },
      'im.chat.member.bot.deleted_v1': async (data: unknown) => {
        const chatId = (data as Record<string, string>)['chat_id'];
        log.info(`Bot removed from chat: ${chatId}`);
      },
    } as Record<string, (data: unknown) => Promise<void>>);

    // Start WebSocket client
    this.wsClient = getWsClient(toCredentials(this.config));
    this.wsClient.start({ eventDispatcher: dispatcher });

    log.info('Feishu gateway started');

    // Keep running until stopped
    return new Promise((resolve) => {
      const checkStopped = setInterval(() => {
        if (!this.isRunning) {
          clearInterval(checkStopped);
          resolve();
        }
      }, 1000);
    });
  }

  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    // Note: SDK WSClient doesn't have explicit stop method
    // The connection closes when process exits
    log.info('Feishu gateway stopped');
  }

  async sendMessage(chatId: string, response: FeishuResponse): Promise<void> {
    await this.sender.sendCard(chatId, response);
  }

  // ── Private Methods ─────────────────────────────────────

  private async handleMessageEvent(
    event: RawMessageEvent,
    options: GatewayOptions,
  ): Promise<void> {
    const message = parseMessage(event, this.config, this.botOpenId);
    if (!message) return;

    log.info(
      `Message from ${message.senderName || message.senderId} in ${message.chatType}`,
    );

    // Add processing reaction
    const reactionId = await this.sender.addReaction(message.id, 'OneSecond');
    if (reactionId) {
      this.activeReactions.set(message.id, reactionId);
    }

    try {
      // Handle slash commands
      const command = isSlashCommand(message.content);
      if (command) {
        const response = await this.handleCommand(command, message);
        await this.sender.sendCard(message.chatId, response, {
          replyToMessageId: message.id,
        });
        return;
      }

      // Use streaming if handler provided
      if (options.onStream) {
        await this.handleStreamingMessage(message, options.onStream);
      } else if (options.onMessage) {
        // Fallback to simple response
        const startTime = Date.now();
        const response = await options.onMessage(message);
        response.elapsedMs = Date.now() - startTime;
        await this.sender.sendCard(message.chatId, response, {
          replyToMessageId: message.id,
        });
      }
    } catch (err) {
      log.error(`Error handling message: ${err}`);
      await this.sender.sendError(
        message.chatId,
        err instanceof Error ? err.message : String(err),
        { replyToMessageId: message.id },
      );
    } finally {
      // Remove reaction and add DONE reaction
      const reactionId = this.activeReactions.get(message.id);
      if (reactionId) {
        await this.sender.removeReaction(message.id, reactionId);
        this.activeReactions.delete(message.id);
      }
      await this.sender.addReaction(message.id, 'DONE');
    }
  }
  /**
   * Handle message with streaming response
   */
  private async handleStreamingMessage(
    message: FeishuMessage,
    onStream: StreamHandler,
  ): Promise<void> {
    // Create and send card immediately for fastest response
    const cardId = await this.sender.createStreamingCard();

    await this.sender.sendCardByRef(message.chatId, cardId, {
      replyToMessageId: message.id,
    });

    let sequence = 1;
    let mainText = '';
    let thinkingText = '';
    let hasThinkingContent = false;
    // Queue to ensure sequential updates with correct sequence numbers
    const updateQueue: Array<() => Promise<void>> = [];
    let isProcessing = false;

    const enqueueUpdate = (updateFn: () => Promise<void>): Promise<void> => {
      return new Promise((resolve, reject) => {
        updateQueue.push(async () => {
          try {
            await updateFn();
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        processQueue();
      });
    };

    const processQueue = async () => {
      if (isProcessing || updateQueue.length === 0) return;
      isProcessing = true;
      while (updateQueue.length > 0) {
        const next = updateQueue.shift()!;
        await next();
      }
      isProcessing = false;
    };

    const updater: StreamUpdater = {
      updateThinking: async (text: string) => {
        thinkingText = text;
        hasThinkingContent = true;
        const currentSeq = sequence++;
        await enqueueUpdate(() =>
          this.sender.updateCard(
            cardId,
            STREAM_EL.thinkingMd,
            thinkingText,
            currentSeq,
          ),
        );
      },

      updateContent: async (text: string) => {
        mainText = text;
        const currentSeq = sequence++;
        await enqueueUpdate(() =>
          this.sender.updateCard(
            cardId,
            STREAM_EL.mainMd,
            mainText,
            currentSeq,
          ),
        );
      },

      appendToolUse: async (name: string, input: unknown) => {
        const inputStr = JSON.stringify(input);
        const truncated =
          inputStr.length > 300 ? inputStr.slice(0, 300) + '…' : inputStr;
        thinkingText += `\n\n> 🔧 **${name}** \`${truncated}\`\n\n`;
        hasThinkingContent = true;
        const currentSeq = sequence++;

        await enqueueUpdate(() =>
          this.sender.updateCard(
            cardId,
            STREAM_EL.thinkingMd,
            thinkingText,
            currentSeq,
          ),
        );
      },

      finalize: async (response: FeishuResponse) => {
        mainText = response.text || mainText;

        const mainSeq = sequence++;
        await enqueueUpdate(() =>
          this.sender.updateCard(cardId, STREAM_EL.mainMd, mainText, mainSeq),
        );

        // Update thinking with final content if we have it
        if (response.thinking) {
          hasThinkingContent = true;
          const thinkingSeq = sequence++;

          await enqueueUpdate(() =>
            this.sender.updateCard(
              cardId,
              STREAM_EL.thinkingMd,
              response.thinking!,
              thinkingSeq,
            ),
          );
        }

        // Hide thinking panel if no thinking content was generated
        if (!hasThinkingContent && !thinkingText) {
          const removeSeq = sequence++;
          await enqueueUpdate(() =>
            this.sender.removeCardElement(
              cardId,
              STREAM_EL.thinkingPanel,
              removeSeq,
            ),
          );
        }

        // Add stats footer
        const stats = this.formatStats(response);
        if (stats) {
          const statsSeq = sequence++;

          await enqueueUpdate(() =>
            this.sender.appendCardElements(
              cardId,
              [
                { tag: 'hr', element_id: STREAM_EL.statsHr },
                {
                  tag: 'markdown',
                  element_id: STREAM_EL.statsNote,
                  content: `*${stats}*`,
                },
              ],
              statsSeq,
            ),
          );
        }

        // Close streaming mode
        const closeSeq = sequence++;

        await enqueueUpdate(() =>
          this.sender.closeCardStreaming(cardId, closeSeq),
        );
      },
    };

    await onStream(message, updater);
  }

  private async handleCommand(
    command: { command: string; args: string },
    message: FeishuMessage,
  ): Promise<FeishuResponse> {
    switch (command.command.toLowerCase()) {
      case 'help':
        return {
          text: [
            '**MomoClaw Bot Commands**',
            '',
            '`/help` - Show this help message',
            '`/clear` - Clear conversation history',
            '`/history` - Show current session message history',
            '`/list` - List all sessions',
            '`/new` - Create a new session',
            '`/status` - Show bot status',
          ].join('\n'),
        };

      case 'clear': {
        const session = this.getOrCreateSession(message);
        clearSessionMessages(session.id);
        return {
          text: '🗑️ Conversation context cleared. Starting fresh!',
        };
      }

      case 'history': {
        const session = this.getOrCreateSession(message);
        const messages = getSessionMessages(session.id, 1000);

        if (messages.length === 0) {
          return {
            text: '📜 No messages in this session.',
          };
        }

        const historyLines = messages.map((msg, index) => {
          const roleEmoji = msg.role === 'user' ? '👤' : '🤖';
          const date = new Date(msg.timestamp).toLocaleString('zh-CN', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          const preview = msg.content.length > 100
            ? msg.content.slice(0, 100) + '...'
            : msg.content;
          return `${index + 1}. ${roleEmoji} **${msg.role}** (${date})\n   > ${preview}`;
        });

        return {
          text: [
            `📜 **Session History** (${messages.length} messages)`,
            '',
            ...historyLines,
          ].join('\n'),
        };
      }

      case 'list': {
        const sessions = listSessions();
        const session = this.getOrCreateSession(message);
        const sessionList = sessions
          .map((s, index) => {
            const isCurrent = s.id === session.id;
            const date = new Date(s.updatedAt).toLocaleString('zh-CN');
            const prefix = isCurrent ? '🌟 ' : '   ';
            return `${index + 1}. ${prefix}${s.name} (${date})`;
          })
          .join('\n\n');
        const text =
          sessions.length === 0
            ? 'No sessions found.'
            : `📋 **All Sessions** (${sessions.length} total):\n\n${sessionList}`;

        return { text };
      }

      case 'new': {
        const chatType = message.chatType === 'p2p' ? 'DM' : 'Group';
        const newSessionId = `feishu_${message.chatId}_${Date.now()}`;

        // Delete old session if exists (using cache to find it)
        const oldSessionId = this.getCachedSessionId(message.chatId);
        if (oldSessionId) {
          deleteSession(oldSessionId);
          log.info(
            `Deleted old session ${oldSessionId} for chat ${message.chatId}`,
          );
        }

        // Create new session
        createSession(
          newSessionId,
          `Feishu ${chatType} ${message.chatId.slice(0, 8)}`,
        );

        // Update cache and persistent mapping
        this.sessionCache.set(message.chatId, newSessionId);
        setMapping(message.chatId, newSessionId);

        return {
          text: `✅ New session created! Session ID: \`${newSessionId}\``,
        };
      }

      case 'status':
        return {
          text: [
            '**MomoClaw Status**',
            '',
            `- Chat Type: ${message.chatType}`,
            `- Chat ID: ${message.chatId}`,
            `- Bot ID: ${this.botOpenId || 'unknown'}`,
            `- SDK: @larksuiteoapi/node-sdk`,
          ].join('\n'),
        };

      default:
        return {
          text: `Unknown command: \`/${command.command}\`. Type \`/help\` for available commands.`,
        };
    }
  }

  /**
   * Get or create a session for the Feishu chat
   * Uses in-memory cache first to reduce DB queries
   */
  private getOrCreateSession(message: FeishuMessage): Session {
    const chatId = message.chatId;

    // 1. Check memory cache first (O(1) lookup)
    const cachedSessionId = this.sessionCache.get(chatId);
    if (cachedSessionId) {
      const session = getSession(cachedSessionId);
      if (session) {
        log.debug(`Cache hit for chat ${chatId} -> ${cachedSessionId}`);
        return session;
      }
      // Cache stale, remove it and clean up DB mapping
      this.sessionCache.delete(chatId);
      deleteMapping(chatId);
      log.debug(`Cleaned up stale cache and mapping for chat ${chatId}`);
    }

    // 2. Check persistent mapping storage
    const mapping = getMapping(chatId);
    if (mapping) {
      const session = getSession(mapping.sessionId);
      if (session) {
        // Update cache
        this.sessionCache.set(chatId, session.id);
        log.debug(`DB mapping found for chat ${chatId} -> ${session.id}`);
        return session;
      }
      // Mapping stale, clean it up
      deleteMapping(chatId);
      log.debug(`Cleaned up stale DB mapping for chat ${chatId}`);
    }

    // 3. Create new session
    const chatType = message.chatType === 'p2p' ? 'DM' : 'Group';
    const sessionId = `feishu_${chatId}_${Date.now()}`;
    const session = createSession(
      sessionId,
      `Feishu ${chatType} ${chatId.slice(0, 8)}`,
    );

    // Update both cache and persistent storage
    this.sessionCache.set(chatId, sessionId);
    setMapping(chatId, sessionId);

    log.info(`Created new session ${sessionId} for chat ${chatId}`);
    return session;
  }

  /**
   * Get cached session ID for a chat (for /new command to find old session)
   */
  private getCachedSessionId(chatId: string): string | undefined {
    // Try cache first
    const cached = this.sessionCache.get(chatId);
    if (cached) return cached;

    // Fallback to DB
    const mapping = getMapping(chatId);
    return mapping?.sessionId;
  }

  private formatStats(response: FeishuResponse): string | null {
    const parts: string[] = [];
    if (response.model) parts.push(response.model);
    if (response.elapsedMs)
      parts.push(`${(response.elapsedMs / 1000).toFixed(1)}s`);
    if (response.inputTokens) parts.push(`${response.inputTokens} in`);
    if (response.outputTokens) parts.push(`${response.outputTokens} out`);

    return parts.length > 0 ? parts.join(' · ') : null;
  }
}
