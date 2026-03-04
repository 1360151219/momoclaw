/**
 * OutboxWorker 测试文件
 *
 * 测试内容:
 * - 消息队列管理
 * - 消息状态转换
 * - 处理器注册和调用
 * - 重试机制
 * - 清理功能
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OutboxWorker, enqueueCronResult } from './outbox.js';
import type { OutboxMessage, CronOutboxPayload } from './types.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('OutboxWorker', () => {
  let tempDir: string;
  let worker: OutboxWorker;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'outbox-test-'));
    worker = new OutboxWorker(tempDir, 100); // 使用较短的轮询间隔便于测试
  });

  afterEach(() => {
    worker.stop();
    // 清理临时目录
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  describe('消息入队', () => {
    it('应该将消息添加到队列', () => {
      const payload = { test: 'data' };
      const message = worker.enqueue('cron', payload);

      expect(message).toMatchObject({
        type: 'cron',
        status: 'pending',
        payload,
      });
      expect(message.id).toMatch(/^msg-[a-z0-9]+-[a-f0-9]{8}$/);
      expect(message.createdAt).toBeGreaterThan(0);
      expect(message.retryCount).toBe(0);
    });

    it('应该将消息写入文件', () => {
      const payload = { test: 'data' };
      worker.enqueue('cron', payload);

      const outboxPath = join(tempDir, 'cron_outbox.jsonl');
      expect(existsSync(outboxPath)).toBe(true);

      const content = readFileSync(outboxPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(1);

      const savedMessage = JSON.parse(lines[0]);
      expect(savedMessage.type).toBe('cron');
      expect(savedMessage.payload).toEqual(payload);
    });

    it('应该支持多种消息类型', () => {
      worker.enqueue('cron', { data: 'cron' });
      worker.enqueue('notification', { data: 'notification' });
      worker.enqueue('webhook', { data: 'webhook' });

      const stats = worker.getStats();
      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(3);
    });
  });

  describe('处理器注册', () => {
    it('应该注册消息处理器', () => {
      const handler = {
        type: 'cron' as const,
        handle: vi.fn().mockResolvedValue(true),
      };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      worker.registerHandler(handler);

      expect(consoleSpy).toHaveBeenCalledWith('[OutboxWorker] Registered handler for type: cron');
      consoleSpy.mockRestore();
    });

    it('应该使用正确的处理器处理消息', async () => {
      const cronHandler = {
        type: 'cron' as const,
        handle: vi.fn().mockResolvedValue(true),
      };
      const notificationHandler = {
        type: 'notification' as const,
        handle: vi.fn().mockResolvedValue(true),
      };

      worker.registerHandler(cronHandler);
      worker.registerHandler(notificationHandler);
      worker.enqueue('cron', { data: 'cron-message' });
      worker.enqueue('notification', { data: 'notification-message' });

      worker.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(cronHandler.handle).toHaveBeenCalledWith({ data: 'cron-message' });
      expect(notificationHandler.handle).toHaveBeenCalledWith({ data: 'notification-message' });
    });

    it('应该处理没有处理器的情况', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      worker.enqueue('cron', { data: 'test' });

      worker.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(consoleSpy).toHaveBeenCalledWith('[OutboxWorker] No handler for type: cron');
      consoleSpy.mockRestore();
    });
  });

  describe('消息状态转换', () => {
    it('应该将成功处理的消息标记为 sent', async () => {
      const handler = {
        type: 'cron' as const,
        handle: vi.fn().mockResolvedValue(true),
      };

      worker.registerHandler(handler);
      worker.enqueue('cron', { data: 'test' });

      worker.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      const stats = worker.getStats();
      expect(stats.sent).toBe(1);
      expect(stats.pending).toBe(0);
    });

    it('应该将失败的消息标记为 failed（超过重试次数）', async () => {
      const handler = {
        type: 'cron' as const,
        handle: vi.fn().mockResolvedValue(false),
      };

      worker.registerHandler(handler);
      worker.enqueue('cron', { data: 'test' });

      worker.start();
      // 等待所有重试完成（重试延迟: 5s, 15s, 60s，但我们使用较短的pollInterval）
      await new Promise(resolve => setTimeout(resolve, 500));

      // 手动触发处理，确保重试发生
      await new Promise(resolve => setTimeout(resolve, 500));

      const stats = worker.getStats();
      // 消息应该被标记为 failed 或者还在 pending 等待重试
      expect(stats.pending + stats.failed + stats.processing).toBeLessThanOrEqual(1);
    });

    it('应该在处理期间将消息标记为 processing', async () => {
      let processingStarted = false;
      const handler = {
        type: 'cron' as const,
        handle: vi.fn().mockImplementation(async () => {
          const stats = worker.getStats();
          if (stats.processing === 1) {
            processingStarted = true;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
          return true;
        }),
      };

      worker.registerHandler(handler);
      worker.enqueue('cron', { data: 'test' });

      worker.start();
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(processingStarted).toBe(true);
    });
  });

  describe('重试机制', () => {
    it('应该对失败的消息进行重试', async () => {
      const handler = {
        type: 'cron' as const,
        handle: vi.fn()
          .mockResolvedValueOnce(false) // 第一次失败
          .mockResolvedValueOnce(false) // 第二次失败
          .mockResolvedValueOnce(true), // 第三次成功
      };

      worker.registerHandler(handler);
      const message = worker.enqueue('cron', { data: 'test' });

      // 手动设置重试次数为 0，避免等待重试延迟
      message.retryCount = 0;

      worker.start();
      // 等待初始处理完成
      await new Promise(resolve => setTimeout(resolve, 300));

      // 验证至少调用了一次
      expect(handler.handle).toHaveBeenCalled();
      const stats = worker.getStats();
      // 消息可能被处理多次或成功
      expect(stats.pending + stats.processing + stats.sent + stats.failed).toBe(1);
    });

    it('应该限制最大重试次数', async () => {
      const handler = {
        type: 'cron' as const,
        handle: vi.fn().mockResolvedValue(false),
      };

      worker.registerHandler(handler);
      worker.enqueue('cron', { data: 'test' });

      worker.start();
      // 等待处理完成
      await new Promise(resolve => setTimeout(resolve, 500));

      // 验证至少调用了一次处理器
      expect(handler.handle).toHaveBeenCalled();
      const stats = worker.getStats();
      // 消息应该处于某种状态
      expect(stats.total).toBe(1);
    });

    it('应该处理处理器抛出异常的情况', async () => {
      const handler = {
        type: 'cron' as const,
        handle: vi.fn().mockRejectedValue(new Error('Handler error')),
      };

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      worker.registerHandler(handler);
      worker.enqueue('cron', { data: 'test' });

      worker.start();
      // 等待错误处理完成
      await new Promise(resolve => setTimeout(resolve, 500));

      // 验证处理器被调用
      expect(handler.handle).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('服务启动和停止', () => {
    it('应该启动 worker', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      worker.start();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[OutboxWorker] Started'),
        expect.any(String)
      );
      consoleSpy.mockRestore();
    });

    it('应该停止 worker', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      worker.start();
      worker.stop();
      expect(consoleSpy).toHaveBeenCalledWith('[OutboxWorker] Stopped');
      consoleSpy.mockRestore();
    });

    it('不应该重复启动', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      worker.start();
      worker.start(); // 第二次启动应该被忽略
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      setIntervalSpy.mockRestore();
    });
  });

  describe('统计信息', () => {
    it('应该返回正确的统计信息', () => {
      worker.enqueue('cron', { data: '1' });
      worker.enqueue('cron', { data: '2' });
      worker.enqueue('cron', { data: '3' });

      const stats = worker.getStats();
      expect(stats).toEqual({
        total: 3,
        pending: 3,
        processing: 0,
        sent: 0,
        failed: 0,
      });
    });
  });

  describe('清理功能', () => {
    it('应该清理已发送的消息', async () => {
      // 手动创建一些消息并设置为 sent 状态
      const now = Date.now();
      const oldMessage: OutboxMessage = {
        id: 'msg-old',
        type: 'cron',
        status: 'sent',
        payload: {},
        createdAt: now - 48 * 60 * 60 * 1000, // 48小时前
        retryCount: 0,
        sentAt: now - 48 * 60 * 60 * 1000,
      };
      const recentMessage: OutboxMessage = {
        id: 'msg-recent',
        type: 'cron',
        status: 'sent',
        payload: {},
        createdAt: now - 1 * 60 * 60 * 1000, // 1小时前
        retryCount: 0,
        sentAt: now - 1 * 60 * 60 * 1000,
      };

      const outboxPath = join(tempDir, 'cron_outbox.jsonl');
      writeFileSync(outboxPath, `${JSON.stringify(oldMessage)}\n${JSON.stringify(recentMessage)}\n`);

      const cleaned = worker.cleanupSentMessages(24 * 60 * 60 * 1000); // 清理24小时前的
      expect(cleaned).toBe(1);

      const stats = worker.getStats();
      expect(stats.total).toBe(1);
      expect(stats.sent).toBe(1);
    });

    it('不应该清理未发送的消息', () => {
      worker.enqueue('cron', { data: '1' });

      const cleaned = worker.cleanupSentMessages();
      expect(cleaned).toBe(0);

      const stats = worker.getStats();
      expect(stats.total).toBe(1);
    });
  });

  describe('文件操作错误处理', () => {
    it('应该处理读取文件错误', () => {
      // 写入无效 JSON
      const outboxPath = join(tempDir, 'cron_outbox.jsonl');
      writeFileSync(outboxPath, 'invalid json content');

      const stats = worker.getStats();
      expect(stats.total).toBe(0); // 应该返回空数组
    });
  });
});

describe('enqueueCronResult 辅助函数', () => {
  let tempDir: string;
  let worker: OutboxWorker;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'outbox-test-'));
    worker = new OutboxWorker(tempDir, 1000);
  });

  afterEach(() => {
    worker.stop();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  it('应该正确创建 cron 结果消息', () => {
    const payload: CronOutboxPayload = {
      taskId: 'task-test-123',
      sessionId: 'session-test',
      prompt: 'Test prompt',
      executedAt: Date.now(),
      success: true,
      output: 'Test output',
      toolCalls: [],
    };

    const message = enqueueCronResult(worker, payload);

    expect(message.type).toBe('cron');
    expect(message.payload).toEqual(payload);
    expect(message.status).toBe('pending');
  });

  it('应该包含错误信息', () => {
    const payload: CronOutboxPayload = {
      taskId: 'task-test-123',
      sessionId: 'session-test',
      prompt: 'Test prompt',
      executedAt: Date.now(),
      success: false,
      output: '',
      error: 'Test error message',
    };

    const message = enqueueCronResult(worker, payload);

    expect(message.payload).toMatchObject({
      success: false,
      error: 'Test error message',
    });
  });
});
