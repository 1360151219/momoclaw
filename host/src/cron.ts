/**
 * CronService - 定时任务调度器
 *
 * 支持三种调度类型:
 * - cron: Cron 表达式 (如 "0 9 * * *" 每天9点)
 * - interval: 间隔秒数 (如 "3600" 每小时)
 * - once: 一次性任务，毫秒时间戳
 */

import { randomBytes } from 'crypto';
import { ScheduleType, ScheduledTask, PromptPayload } from './types.js';
import {
  getDueTasks,
  updateTaskAfterRun,
  addTaskRunLog,
  getSession,
  addMessage,
  getSessionMessages,
  updateSessionSdkState,
} from './db.js';
import { runContainerAgent } from './container.js';
import { getApiConfig, config } from './config.js';
import { OutboxWorker, enqueueCronResult } from './outbox.js';

// Cron 表达式解析 (简化版)
// 格式: "分 时 日 月 周"
// 支持: * 表示任意, 具体数字, 逗号分隔多个值
interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

export class CronService {
  private running = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;
  private executingTasks = new Set<string>(); // 防止重复执行
  private outboxWorker?: OutboxWorker;

  constructor(pollIntervalMs: number = 30000, outboxWorker?: OutboxWorker) {
    this.pollIntervalMs = pollIntervalMs;
    this.outboxWorker = outboxWorker;
  }

  /**
   * 设置 OutboxWorker
   */
  setOutboxWorker(worker: OutboxWorker): void {
    this.outboxWorker = worker;
  }

  /**
   * 启动调度器
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    console.log('[CronService] Scheduler started');

    // 立即执行一次检查
    this.checkAndRunTasks();

    // 设置定时检查
    this.intervalId = setInterval(() => {
      this.checkAndRunTasks();
    }, this.pollIntervalMs);
  }

  /**
   * 停止调度器
   */
  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[CronService] Scheduler stopped');
  }

  /**
   * 检查并执行到期的任务
   */
  private async checkAndRunTasks(): Promise<void> {
    if (!this.running) return;

    const now = Date.now();
    const dueTasks = getDueTasks(now);

    for (const task of dueTasks) {
      // 防止同一任务被并发执行
      if (this.executingTasks.has(task.id)) continue;

      this.executingTasks.add(task.id);

      try {
        await this.executeTask(task);
      } catch (err) {
        console.error(`[CronService] Task ${task.id} failed:`, err);

        // 记录失败日志
        const errorMsg = err instanceof Error ? err.message : String(err);
        addTaskRunLog(task.id, false, '', errorMsg);
        updateTaskAfterRun(
          task.id,
          this.calculateNextRun(task),
          errorMsg,
          'failed',
        );
      } finally {
        this.executingTasks.delete(task.id);
      }
    }
  }

  /**
   * 执行单个任务
   */
  private async executeTask(task: ScheduledTask): Promise<void> {
    console.log(`[CronService] Executing task: ${task.id}`);

    const session = getSession(task.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${task.sessionId}`);
    }

    // 构建执行提示词
    const executionPrompt = `[Scheduled Task]\n${task.prompt}`;

    // 保存任务触发消息
    addMessage(task.sessionId, 'user', executionPrompt);

    // 获取历史消息
    const history = getSessionMessages(task.sessionId, 50);

    // 构建 payload
    const payload: PromptPayload = {
      session: {
        ...session,
        systemPrompt: session.systemPrompt || config.defaultSystemPrompt,
      },
      messages: history.slice(0, -1),
      userInput: executionPrompt,
      apiConfig: getApiConfig(config, session.model || undefined),
    };

    let output = '';
    let error: string | undefined;
    let success = false;
    let sdkSessionId: string | undefined;
    let sdkResumeAt: string | undefined;
    let toolCalls: import('./types.js').ToolCall[] | undefined;

    try {
      const result = await runContainerAgent(payload, (chunk) => {
        output += chunk;
      });

      success = result.success;

      if (result.success) {
        output = output || result.content;
        sdkSessionId = result.sdkSessionId;
        sdkResumeAt = result.sdkResumeAt;
        toolCalls = result.toolCalls;

        // 保存助手回复
        addMessage(task.sessionId, 'assistant', output, toolCalls);

        // 更新 SDK 会话状态
        if (sdkSessionId || sdkResumeAt) {
          updateSessionSdkState(task.sessionId, sdkSessionId, sdkResumeAt);
        }
      } else {
        error = result.error || 'Unknown error';
        output = result.content;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      success = false;
    }

    // 记录执行日志
    addTaskRunLog(task.id, success, output, error);

    // 写入 Outbox（如果配置了 OutboxWorker）
    if (this.outboxWorker) {
      enqueueCronResult(this.outboxWorker, {
        taskId: task.id,
        sessionId: task.sessionId,
        prompt: task.prompt,
        executedAt: Date.now(),
        success,
        output,
        error,
        toolCalls,
      });
      console.log(`[CronService] Task ${task.id} result enqueued to outbox`);
    }

    // 计算下次执行时间
    const nextRun = this.calculateNextRun(task);

    // 更新任务状态
    const resultMsg = success ? 'Success' : `Failed: ${error}`;
    updateTaskAfterRun(
      task.id,
      nextRun,
      resultMsg,
      nextRun === null ? 'completed' : undefined,
    );

    console.log(
      `[CronService] Task ${task.id} completed: ${success ? 'success' : 'failed'}`,
    );
  }

  /**
   * 计算下次执行时间
   */
  private calculateNextRun(task: ScheduledTask): number | null {
    const now = Date.now();

    switch (task.scheduleType) {
      case 'once':
        // 一次性任务，执行完就结束
        return 0;

      case 'interval': {
        // 间隔秒数
        const seconds = parseInt(task.scheduleValue, 10);
        if (isNaN(seconds) || seconds <= 0) {
          return 0;
        }
        return now + seconds * 1000;
      }

      case 'cron': {
        // Cron 表达式
        return this.calculateNextCronRun(task.scheduleValue, now);
      }

      default:
        return null;
    }
  }

  /**
   * 计算下次 Cron 执行时间
   */
  private calculateNextCronRun(
    cronExpr: string,
    fromTime: number,
  ): number | null {
    try {
      const fields = this.parseCronExpression(cronExpr);
      const date = new Date(fromTime);

      // 从下一分钟开始查找
      date.setMinutes(date.getMinutes() + 1);
      date.setSeconds(0);
      date.setMilliseconds(0);

      // 最多查找 366 天
      for (let i = 0; i < 366 * 24 * 60; i++) {
        if (this.matchesCron(date, fields)) {
          return date.getTime();
        }
        date.setMinutes(date.getMinutes() + 1);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * 解析 Cron 表达式
   */
  private parseCronExpression(expr: string): CronFields {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error('Invalid cron expression: expected 5 fields');
    }

    return {
      minute: this.parseCronField(parts[0], 0, 59),
      hour: this.parseCronField(parts[1], 0, 23),
      dayOfMonth: this.parseCronField(parts[2], 1, 31),
      month: this.parseCronField(parts[3], 1, 12),
      dayOfWeek: this.parseCronField(parts[4], 0, 6),
    };
  }

  /**
   * 解析单个 Cron 字段
   */
  private parseCronField(field: string, min: number, max: number): number[] {
    if (field === '*') {
      return [];
    }

    const values = new Set<number>();
    const parts = field.split(',');

    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        for (let i = start; i <= end; i++) {
          if (i >= min && i <= max) values.add(i);
        }
      } else {
        const val = Number(part);
        if (val >= min && val <= max) values.add(val);
      }
    }

    return Array.from(values).sort((a, b) => a - b);
  }

  /**
   * 检查日期是否匹配 Cron 表达式
   */
  private matchesCron(date: Date, fields: CronFields): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1;
    const dayOfWeek = date.getDay();

    // 空数组表示任意值 (*)
    if (fields.minute.length > 0 && !fields.minute.includes(minute))
      return false;
    if (fields.hour.length > 0 && !fields.hour.includes(hour)) return false;

    // 日期和周几是 "或" 关系
    const dayOfMonthMatch =
      fields.dayOfMonth.length === 0 || fields.dayOfMonth.includes(dayOfMonth);
    const dayOfWeekMatch =
      fields.dayOfWeek.length === 0 || fields.dayOfWeek.includes(dayOfWeek);
    if (!dayOfMonthMatch && !dayOfWeekMatch) return false;

    if (fields.month.length > 0 && !fields.month.includes(month)) return false;

    return true;
  }

  /**
   * 生成任务 ID
   */
  static generateTaskId(): string {
    return `task-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  }

  /**
   * 验证 Cron 表达式
   */
  static validateCronExpression(expr: string): boolean {
    try {
      const parts = expr.trim().split(/\s+/);
      if (parts.length !== 5) return false;

      const service = new CronService();
      service.parseCronExpression(expr);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 计算初始下次执行时间
   */
  static calculateInitialNextRun(
    scheduleType: ScheduleType,
    scheduleValue: string,
  ): number {
    const now = Date.now();

    switch (scheduleType) {
      case 'once': {
        // 毫秒时间戳
        const timestamp = new Date(Number(scheduleValue)).getTime();
        // console.log(
        //   '[calculateInitialNextRun scheduleType=noce]',
        //   'scheduleValue: ',
        //   scheduleValue,
        //   'nextRun: ',
        //   new Date(timestamp).toLocaleTimeString(),
        //   'now: ',
        //   new Date(now).toLocaleTimeString(),
        // );
        return isNaN(timestamp) ? now : timestamp;
      }

      case 'interval': {
        const seconds = parseInt(scheduleValue, 10);
        if (isNaN(seconds) || seconds <= 0) {
          return now + 3600000; // 默认1小时后
        }
        return now + seconds * 1000;
      }

      case 'cron': {
        const service = new CronService();
        const nextRun = service.calculateNextCronRun(scheduleValue, now);
        return nextRun || now + 60000;
      }

      default:
        return now + 3600000;
    }
  }
}

// 导出单例实例
export const cronService = new CronService(60000); // 每分钟检查一次
