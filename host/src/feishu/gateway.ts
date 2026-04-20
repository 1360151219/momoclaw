/**
 * Feishu Gateway - Main entry point using official SDK
 * Uses @larksuiteoapi/node-sdk for WebSocket and event handling
 */

import type * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuSender, STREAM_EL, type CardOpResult } from './sender.js';
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
import { parseMessage } from './receiver.js';
import { listMappings } from '../db/index.js';
import { executeCommand, type CommandContext } from './commands.js';
import { parseCommand } from '../utils/command.js';

const log = logger('feishu:gateway');

export interface GatewayOptions {
  onMessage?: MessageHandler;
  onStream?: StreamHandler;
}

export type StreamHandler = (
  message: FeishuMessage,
  updater: StreamUpdater,
  sessionCache: Map<string, string>,
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
      `Message from ${message.senderName || message.senderId} in ${message.chatType}: ${message.content}`,
    );

    // Add processing reaction
    const reactionId = await this.sender.addReaction(message.id, 'OneSecond');
    if (reactionId) {
      this.activeReactions.set(message.id, reactionId);
    }

    try {
      // Handle slash commands
      const command = parseCommand(message.content);
      if (command) {
        const context: CommandContext = {
          chatId: message.chatId,
          sessionCache: this.sessionCache,
          botOpenId: this.botOpenId,
        };
        const response = await executeCommand(
          command.command,
          message,
          context,
        );
        await this.sender.sendCard(message.chatId, response, {
          replyToMessageId: message.id,
        });
        return;
      }

      // Use streaming if handler provided
      if (options.onStream) {
        await this.handleStreamingMessage(
          message,
          options.onStream,
          this.sessionCache,
        );
      } else if (options.onMessage) {
        // Fallback to simple response
        const startTime = Date.now();
        const response = await options.onMessage(message);
        response.elapsedMs = Date.now() - startTime;

        // Process markdown for images and files before sending card
        if (response.text) {
          response.text = await this.sender.processMarkdownResources(
            response.text,
            message.chatId,
            { replyToMessageId: message.id },
          );
        }

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
    sessionCache: Map<string, string>,
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
    let cardStreamingBroken = false;
    let fallbackReplySent = false;
    // Queue to ensure sequential updates with correct sequence numbers
    const updateQueue: Array<() => Promise<void>> = [];
    let isProcessing = false;

    const nextSequence = (): number => sequence++;

    const enqueueUpdate = <T>(updateFn: () => Promise<T>): Promise<T> => {
      return new Promise((resolve, reject) => {
        updateQueue.push(async () => {
          try {
            const result = await updateFn();
            resolve(result);
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

    const ensureStreamingModeOpen = async (
      reason: string,
    ): Promise<boolean> => {
      const reopenSeq = nextSequence();
      const reopenRes = await this.sender.openCardStreaming(cardId, reopenSeq);
      if (!reopenRes.ok) {
        cardStreamingBroken = true;
        log.error(
          `Failed to re-open card streaming during ${reason}: ${reopenRes.msg || reopenRes.code || 'unknown error'}`,
        );
        return false;
      }
      log.warn(`Re-opened card streaming during ${reason}`);
      return true;
    };

    const runCardOperation = async (
      label: string,
      operation: (sequence: number) => Promise<CardOpResult>,
    ): Promise<boolean> => {
      if (cardStreamingBroken) {
        return false;
      }

      const firstRes = await operation(nextSequence());
      if (firstRes.ok) {
        return true;
      }

      if (firstRes.status !== 'streaming_closed') {
        log.warn(
          `Card operation ${label} failed: ${firstRes.msg || firstRes.code || 'unknown error'}`,
        );
        return false;
      }

      log.warn(
        `Card operation ${label} hit closed streaming mode, attempting to re-open`,
      );
      const reopened = await ensureStreamingModeOpen(label);
      if (!reopened) {
        return false;
      }

      const retryRes = await operation(nextSequence());
      if (retryRes.ok) {
        return true;
      }

      if (retryRes.status === 'streaming_closed') {
        cardStreamingBroken = true;
      }
      log.warn(
        `Card operation ${label} failed after re-opening: ${retryRes.msg || retryRes.code || 'unknown error'}`,
      );
      return false;
    };

    const sendFallbackReply = async (
      response: FeishuResponse,
    ): Promise<void> => {
      if (fallbackReplySent) {
        return;
      }
      fallbackReplySent = true;

      let fallbackText = response.text || mainText || ' ';
      try {
        fallbackText = await this.sender.processMarkdownResources(
          fallbackText,
          message.chatId,
          { replyToMessageId: message.id },
        );
      } catch (err) {
        log.warn(`Failed to process fallback markdown resources: ${err}`);
      }

      await this.sender.sendCard(
        message.chatId,
        {
          ...response,
          text: fallbackText,
          thinking: response.thinking || thinkingText || undefined,
        },
        { replyToMessageId: message.id },
      );
      log.warn(
        'Sent fallback non-streaming reply because streaming card could not be updated',
      );
    };

    const updater: StreamUpdater = {
      updateThinking: async (text: string) => {
        thinkingText = text;
        hasThinkingContent = true;
        await enqueueUpdate(() =>
          runCardOperation('update thinking', (seq) =>
            this.sender.updateCard(
              cardId,
              STREAM_EL.thinkingMd,
              thinkingText,
              seq,
            ),
          ),
        );
      },

      updateContent: async (text: string) => {
        mainText = text;
        await enqueueUpdate(() =>
          runCardOperation('update content', (seq) =>
            this.sender.updateCard(cardId, STREAM_EL.mainMd, mainText, seq),
          ),
        );
      },

      appendToolUse: async (name: string, input: unknown) => {
        const inputStr = JSON.stringify(input);
        const truncated =
          inputStr.length > 300 ? inputStr.slice(0, 300) + '…' : inputStr;
        thinkingText += `\n\n> 🔧 **${name}** \`${truncated}\`\n\n`;
        hasThinkingContent = true;

        await enqueueUpdate(() =>
          runCardOperation('append tool use', (seq) =>
            this.sender.updateCard(
              cardId,
              STREAM_EL.thinkingMd,
              thinkingText,
              seq,
            ),
          ),
        );
      },

      finalize: async (response: FeishuResponse) => {
        // 用 try/finally 包裹所有中间步骤，确保无论是否出错，
        // 最终都会执行 closeCardStreaming 关闭流式模式，
        // 避免卡片因 streaming_mode 未关闭而一直显示加载状态。
        log.info(`Finalizing stream for ${response.text}`);
        try {
          let finalText = response.text || mainText;

          // Process markdown for images and files before finalizing
          if (finalText) {
            try {
              finalText = await this.sender.processMarkdownResources(
                finalText,
                message.chatId,
                { replyToMessageId: message.id },
              );
            } catch (err) {
              log.warn(
                `Failed to process markdown resources, using raw text: ${err}`,
              );
            }
          }

          const mainOk = await enqueueUpdate(() =>
            runCardOperation('finalize main content', (seq) =>
              this.sender.updateCard(cardId, STREAM_EL.mainMd, finalText, seq),
            ),
          );
          if (!mainOk) {
            await sendFallbackReply({ ...response, text: finalText });
          }

          // Update thinking with final content if we have it
          if (response.thinking) {
            hasThinkingContent = true;
            await enqueueUpdate(() =>
              runCardOperation('finalize thinking', (seq) =>
                this.sender.updateCard(
                  cardId,
                  STREAM_EL.thinkingMd,
                  response.thinking!,
                  seq,
                ),
              ),
            );
          }

          // Hide thinking panel if no thinking content was generated
          if (!hasThinkingContent && !thinkingText) {
            await enqueueUpdate(() =>
              runCardOperation('remove thinking panel', (seq) =>
                this.sender.removeCardElement(
                  cardId,
                  STREAM_EL.thinkingPanel,
                  seq,
                ),
              ),
            );
          }

          // Add stats footer
          const stats = this.formatStats(response);
          if (stats) {
            await enqueueUpdate(() =>
              runCardOperation('append stats footer', (seq) =>
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
                  seq,
                ),
              ),
            );
          }
        } catch (err) {
          log.error(`Error during finalize card updates: ${err}`);
          await sendFallbackReply(response);
        } finally {
          // 无论前面是否出错，都必须关闭流式模式，
          // 否则飞书卡片会一直卡在"加载中"状态。
          if (!cardStreamingBroken) {
            await enqueueUpdate(async () => {
              await this.sender.closeCardStreaming(cardId, nextSequence());
            });
          }
        }
      },
    };

    try {
      await onStream(message, updater, sessionCache);
    } catch (err) {
      // 兜底保护：如果 onStream 回调异常导致 finalize 未被调用，
      // 确保流式模式仍会被关闭，防止卡片永远卡在加载状态。
      log.error(
        `Stream handler error, ensuring card streaming is closed: ${err}`,
      );
      try {
        if (!cardStreamingBroken) {
          await this.sender.closeCardStreaming(cardId, nextSequence());
        }
      } catch (closeErr) {
        log.warn(`Failed to close card streaming after error: ${closeErr}`);
      }
      throw err;
    }
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
