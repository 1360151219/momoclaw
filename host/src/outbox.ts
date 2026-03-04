/**
 * OutboxWorker - 消息投递队列
 *
 * 负责处理异步消息推送：
 * 1. 接收消息写入 cron_outbox.jsonl
 * 2. 轮询 pending 消息并尝试推送
 * 3. 更新消息状态 (pending -> processing -> sent/failed)
 * 4. 支持失败重试（指数退避）
 */

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import {
  OutboxMessage,
  OutboxMessageStatus,
  OutboxMessageType,
  CronOutboxPayload,
} from './types.js';

const OUTBOX_FILENAME = 'cron_outbox.jsonl';
const MAX_RETRY_COUNT = 3;
const RETRY_DELAYS = [5000, 15000, 60000]; // 5s, 15s, 60s

export interface OutboxHandler {
  type: OutboxMessageType;
  handle: (payload: unknown) => Promise<boolean>;
}

export class OutboxWorker {
  private running = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;
  private readonly outboxPath: string;
  private handlers = new Map<OutboxMessageType, OutboxHandler>();
  private processing = new Set<string>(); // 防止并发处理同一条消息

  constructor(workspaceDir: string, pollIntervalMs: number = 10000) {
    this.outboxPath = join(workspaceDir, OUTBOX_FILENAME);
    this.pollIntervalMs = pollIntervalMs;

    // 确保目录存在
    const dir = dirname(this.outboxPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 注册消息处理器
   */
  registerHandler(handler: OutboxHandler): void {
    this.handlers.set(handler.type, handler);
    console.log(`[OutboxWorker] Registered handler for type: ${handler.type}`);
  }

  /**
   * 启动 Worker
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    console.log('[OutboxWorker] Started, outbox:', this.outboxPath);

    // 立即处理一次
    this.processPendingMessages();

    // 设置定时轮询
    this.intervalId = setInterval(() => {
      this.processPendingMessages();
    }, this.pollIntervalMs);
  }

  /**
   * 停止 Worker
   */
  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[OutboxWorker] Stopped');
  }

  /**
   * 添加消息到 Outbox
   */
  enqueue(type: OutboxMessageType, payload: unknown): OutboxMessage {
    const message: OutboxMessage = {
      id: this.generateMessageId(),
      type,
      status: 'pending',
      payload,
      createdAt: Date.now(),
      retryCount: 0,
    };

    this.appendMessage(message);
    console.log(`[OutboxWorker] Enqueued ${type} message: ${message.id}`);
    return message;
  }

  /**
   * 处理所有 pending 消息
   */
  private async processPendingMessages(): Promise<void> {
    if (!this.running) return;

    const messages = this.readAllMessages();
    const pendingMessages = messages.filter(
      (m) => m.status === 'pending' && !this.processing.has(m.id)
    );

    for (const message of pendingMessages) {
      // 检查是否需要延迟重试
      if (message.retryCount > 0) {
        const delay = RETRY_DELAYS[Math.min(message.retryCount - 1, RETRY_DELAYS.length - 1)];
        const timeSinceCreated = Date.now() - message.createdAt;
        if (timeSinceCreated < delay) {
          continue; // 还没等到重试时间
        }
      }

      this.processing.add(message.id);

      try {
        await this.processMessage(message);
      } catch (err) {
        console.error(`[OutboxWorker] Error processing ${message.id}:`, err);
        this.updateMessageStatus(message.id, 'failed', String(err));
      } finally {
        this.processing.delete(message.id);
      }
    }
  }

  /**
   * 处理单条消息
   */
  private async processMessage(message: OutboxMessage): Promise<void> {
    const handler = this.handlers.get(message.type);
    if (!handler) {
      console.warn(`[OutboxWorker] No handler for type: ${message.type}`);
      this.updateMessageStatus(message.id, 'failed', 'No handler registered');
      return;
    }

    // 更新状态为 processing
    this.updateMessageStatus(message.id, 'processing');

    try {
      const success = await handler.handle(message.payload);

      if (success) {
        this.updateMessageStatus(message.id, 'sent');
        console.log(`[OutboxWorker] Message ${message.id} sent successfully`);
      } else {
        // 处理失败，尝试重试
        if (message.retryCount < MAX_RETRY_COUNT) {
          this.updateMessageStatus(message.id, 'pending', undefined, message.retryCount + 1);
          console.log(
            `[OutboxWorker] Message ${message.id} failed, retry ${message.retryCount + 1}/${MAX_RETRY_COUNT}`
          );
        } else {
          this.updateMessageStatus(message.id, 'failed', 'Max retries exceeded');
          console.log(`[OutboxWorker] Message ${message.id} failed after ${MAX_RETRY_COUNT} retries`);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (message.retryCount < MAX_RETRY_COUNT) {
        this.updateMessageStatus(message.id, 'pending', errorMsg, message.retryCount + 1);
        console.log(
          `[OutboxWorker] Message ${message.id} error, retry ${message.retryCount + 1}/${MAX_RETRY_COUNT}: ${errorMsg}`
        );
      } else {
        this.updateMessageStatus(message.id, 'failed', errorMsg);
      }
    }
  }

  /**
   * 读取所有消息
   */
  private readAllMessages(): OutboxMessage[] {
    if (!existsSync(this.outboxPath)) {
      return [];
    }

    try {
      const content = readFileSync(this.outboxPath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());
      return lines.map((line) => JSON.parse(line));
    } catch (err) {
      console.error('[OutboxWorker] Error reading outbox:', err);
      return [];
    }
  }

  /**
   * 追加消息到文件
   */
  private appendMessage(message: OutboxMessage): void {
    try {
      const line = JSON.stringify(message) + '\n';
      appendFileSync(this.outboxPath, line, 'utf-8');
    } catch (err) {
      console.error('[OutboxWorker] Error writing to outbox:', err);
      throw err;
    }
  }

  /**
   * 更新消息状态
   */
  private updateMessageStatus(
    messageId: string,
    status: OutboxMessageStatus,
    lastError?: string,
    retryCount?: number
  ): void {
    const messages = this.readAllMessages();
    const updatedMessages = messages.map((m) => {
      if (m.id === messageId) {
        return {
          ...m,
          status,
          ...(lastError !== undefined && { lastError }),
          ...(retryCount !== undefined && { retryCount }),
          ...(status === 'sent' && { sentAt: Date.now() }),
        };
      }
      return m;
    });

    this.writeAllMessages(updatedMessages);
  }

  /**
   * 写入所有消息（覆盖写）
   */
  private writeAllMessages(messages: OutboxMessage[]): void {
    try {
      const content = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
      writeFileSync(this.outboxPath, content, 'utf-8');
    } catch (err) {
      console.error('[OutboxWorker] Error updating outbox:', err);
    }
  }

  /**
   * 生成消息 ID
   */
  private generateMessageId(): string {
    return `msg-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  }

  /**
   * 获取统计信息
   */
  getStats(): { total: number; pending: number; processing: number; sent: number; failed: number } {
    const messages = this.readAllMessages();
    return {
      total: messages.length,
      pending: messages.filter((m) => m.status === 'pending').length,
      processing: messages.filter((m) => m.status === 'processing').length,
      sent: messages.filter((m) => m.status === 'sent').length,
      failed: messages.filter((m) => m.status === 'failed').length,
    };
  }

  /**
   * 清理已发送的消息（可选，用于定期维护）
   */
  cleanupSentMessages(olderThanMs: number = 24 * 60 * 60 * 1000): number {
    const messages = this.readAllMessages();
    const now = Date.now();
    const remaining = messages.filter(
      (m) => !(m.status === 'sent' && m.sentAt && now - m.sentAt > olderThanMs)
    );

    const cleaned = messages.length - remaining.length;
    if (cleaned > 0) {
      this.writeAllMessages(remaining);
      console.log(`[OutboxWorker] Cleaned up ${cleaned} sent messages`);
    }
    return cleaned;
  }
}

/**
 * 创建 Cron 消息并添加到 Outbox
 */
export function enqueueCronResult(
  worker: OutboxWorker,
  payload: CronOutboxPayload
): OutboxMessage {
  return worker.enqueue('cron', payload);
}
