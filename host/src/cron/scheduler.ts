/**
 * CronService - 定时任务调度器
 *
 * 支持三种调度类型:
 * - cron: Cron 表达式 (如 "0 9 * * *" 每天9点)
 * - interval: 间隔秒数 (如 "3600" 每小时)
 * - once: 一次性任务，毫秒时间戳
 */

import { randomBytes } from 'crypto';
import { ScheduleType, ScheduledTask, PromptPayload } from '../types.js';
import {
  getDueTasks,
  updateTaskAfterRun,
  addTaskRunLog,
  getSession,
  addMessage,
} from '../db/index.js';
import { runContainerAgent } from '../container.js';
import { getApiConfig, config } from '../config.js';
import { channelRegistry } from './sender.js';
import { sessionQueue } from '../core/sessionQueue.js';

import { CronExpressionParser } from 'cron-parser';

export interface CronServiceOptions {
  pollIntervalMs?: number;
}

export class CronService {
  private running = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;
  private executingTasks = new Set<string>(); // 防止重复执行

  constructor(options: CronServiceOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 10000;
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

    const taskPromises = dueTasks.map(async (task) => {
      // 防止同一任务被并发执行
      if (this.executingTasks.has(task.id)) return;

      this.executingTasks.add(task.id);

      try {
        // 使用 sessionQueue 保证同一 Session 的任务串行执行，避免上下文冲突
        await sessionQueue.enqueue(task.sessionId, () =>
          this.executeTask(task),
        );
      } catch (err) {
        console.error(`[CronService] Task ${task.id} failed:`, err);

        try {
          // 记录失败日志
          const errorMsg = err instanceof Error ? err.message : String(err);
          addTaskRunLog(task.id, false, '', errorMsg);
          updateTaskAfterRun(
            task.id,
            this.calculateNextRun(task),
            errorMsg,
            'failed',
          );
        } catch (logErr) {
          console.error(
            `[CronService] Failed to log error for task ${task.id}:`,
            logErr,
          );
        }
      } finally {
        this.executingTasks.delete(task.id);
      }
    });

    // 跨会话并发执行任务
    await Promise.all(taskPromises);
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

    // 构建 payload - 包含 claudeSessionId 以便容器内的 Claude Agent SDK 使用 resume 机制恢复历史上下文
    const payload: PromptPayload = {
      session: {
        ...session,
        systemPrompt: session.systemPrompt || config.defaultSystemPrompt,
      },
      messages: [], // 容器端将使用 resume(claudeSessionId) 来加载持久化的历史
      userInput: executionPrompt,
      apiConfig: getApiConfig(config, session.model || undefined),
    };

    let output = '';
    let error: string | undefined;
    let success = false;
    let toolCalls: import('../types.js').ToolCall[] | undefined;

    try {
      const result = await runContainerAgent(payload, (chunk) => {
        output += chunk;
      });
      success = result.success;

      if (result.success) {
        output = output || result.content;
        toolCalls = result.toolCalls;

        // 只有在任务真正执行成功后，才把用户的触发提示词和 AI 的回复一起存入数据库
        addMessage(task.sessionId, 'user', executionPrompt);
        // 保存助手回复
        addMessage(task.sessionId, 'assistant', output, toolCalls);
      } else {
        error = result.error || 'Unknown error';
        output = result.content;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      success = false;
    }

    try {
      // 记录执行日志
      addTaskRunLog(task.id, success, output, error);

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
    } catch (err) {
      console.error(
        `[CronService] Failed to save task run log or update task status for ${task.id}:`,
        err,
      );
    }

    // 推送结果到对应渠道
    await this.pushResultToChannel(task, output, error, success);
  }

  /**
   * 推送任务结果到对应渠道
   */
  private async pushResultToChannel(
    task: ScheduledTask,
    output: string,
    error: string | undefined,
    success: boolean,
  ): Promise<void> {
    // 如果没有渠道信息，直接返回
    if (!task.channelType || !task.channelId) {
      console.log(
        `[CronService] Task ${task.id} has no channel info, skipping push`,
      );
      return;
    }

    // 构建推送内容
    const content = success
      ? output || '任务执行完成（无输出）'
      : `❌ 任务执行失败: ${error || '未知错误'}`;

    // 通过 ChannelRegistry 推送
    const pushed = await channelRegistry.sendMessage(
      task.channelType,
      task.channelId,
      content,
    );

    if (pushed) {
      console.log(
        `[CronService] Task ${task.id} result pushed to ${task.channelType}`,
      );
    } else {
      console.log(
        `[CronService] Failed to push task ${task.id} result to ${task.channelType}`,
      );
    }
  }

  /**
   * 计算下次执行时间
   */
  private calculateNextRun(task: ScheduledTask): number | null {
    const now = Date.now();

    switch (task.scheduleType) {
      case 'once':
        // 一次性任务，执行完就结束
        return null;

      case 'interval': {
        // 间隔秒数
        const seconds = parseInt(task.scheduleValue, 10);
        if (isNaN(seconds) || seconds <= 0) {
          return null;
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
   * 使用 cron-parser 库来保证计算的准确性
   */
  private calculateNextCronRun(
    cronExpr: string,
    fromTime: number,
  ): number | null {
    try {
      const interval = CronExpressionParser.parse(cronExpr, {
        currentDate: new Date(fromTime),
      });
      return interval.next().getTime();
    } catch (err) {
      console.error(
        `[CronService] Failed to parse cron expression: ${cronExpr}`,
        err,
      );
      return null;
    }
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
      CronExpressionParser.parse(expr);
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
        // 尝试解析为 ISO 日期字符串，如果不是则尝试解析为毫秒时间戳
        let timestamp = new Date(scheduleValue).getTime();
        if (isNaN(timestamp)) {
          timestamp = new Date(Number(scheduleValue)).getTime();
        }
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

// 导出单例实例（不带 UI 回调，适合非终端环境）
export const cronService = new CronService({ pollIntervalMs: 30000 }); //
