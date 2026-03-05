/**
 * CronService 测试文件
 *
 * 测试内容:
 * - Cron 表达式解析
 * - Cron 表达式验证
 * - 下次执行时间计算
 * - 任务调度逻辑
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CronService } from '../cron.js';
import * as db from '../db.js';

// Mock db 模块
vi.mock('./db.js', () => ({
  getDueTasks: vi.fn(),
  updateTaskAfterRun: vi.fn(),
  addTaskRunLog: vi.fn(),
  getSession: vi.fn(),
  addMessage: vi.fn(),
  getSessionMessages: vi.fn(),
  updateSessionSdkState: vi.fn(),
}));

// Mock container 模块
vi.mock('./container.js', () => ({
  runContainerAgent: vi.fn(),
}));

// Mock config 模块
vi.mock('./config.js', () => ({
  getApiConfig: vi.fn(() => ({
    provider: 'anthropic' as const,
    model: 'claude-3-5-sonnet-20241022',
    apiKey: 'test-api-key',
    maxTokens: 4096,
  })),
  config: {
    defaultSystemPrompt: 'You are a test assistant',
    workspaceDir: './workspace',
  },
}));

describe('CronService', () => {
  let service: CronService;

  beforeEach(() => {
    service = new CronService(1000); // 使用较短的轮询间隔便于测试
    vi.clearAllMocks();
  });

  afterEach(() => {
    service.stop();
    // 确保 getDueTasks 始终返回数组，防止异步操作出错
    vi.mocked(db.getDueTasks).mockReturnValue([]);
  });

  describe('Cron 表达式解析', () => {
    it('应该正确解析简单的 Cron 表达式', () => {
      const service = new CronService();
      // 使用反射访问私有方法
      const parseCronExpression = (service as any).parseCronExpression.bind(service);

      const fields = parseCronExpression('0 9 * * *'); // 每天9点

      expect(fields.minute).toEqual([0]);
      expect(fields.hour).toEqual([9]);
      expect(fields.dayOfMonth).toEqual([]); // * 表示任意
      expect(fields.month).toEqual([]); // * 表示任意
      expect(fields.dayOfWeek).toEqual([]); // * 表示任意
    });

    it('应该正确解析包含列表的 Cron 表达式', () => {
      const service = new CronService();
      const parseCronExpression = (service as any).parseCronExpression.bind(service);

      const fields = parseCronExpression('0,30 9,18 * * 1-5'); // 工作日9点和18点，每小时的0分和30分

      expect(fields.minute).toEqual([0, 30]);
      expect(fields.hour).toEqual([9, 18]);
      expect(fields.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    it('应该正确解析包含范围的 Cron 表达式', () => {
      const service = new CronService();
      const parseCronExpression = (service as any).parseCronExpression.bind(service);

      const fields = parseCronExpression('0 9-17 * * 1-5'); // 工作日9点到17点

      expect(fields.minute).toEqual([0]);
      expect(fields.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
      expect(fields.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    it('应该抛出错误当表达式格式不正确', () => {
      const service = new CronService();
      const parseCronExpression = (service as any).parseCronExpression.bind(service);

      expect(() => parseCronExpression('0 9 * *')).toThrow('expected 5 fields');
      expect(() => parseCronExpression('0 9 * * * *')).toThrow('expected 5 fields');
    });
  });

  describe('Cron 表达式验证', () => {
    it('应该验证有效的 Cron 表达式', () => {
      expect(CronService.validateCronExpression('0 9 * * *')).toBe(true);
      expect(CronService.validateCronExpression('*/5 * * * *')).toBe(true);
      expect(CronService.validateCronExpression('0 0 1 1 *')).toBe(true);
      expect(CronService.validateCronExpression('0,30 9-17 * * 1-5')).toBe(true);
    });

    it('应该拒绝无效的 Cron 表达式', () => {
      expect(CronService.validateCronExpression('0 9 * *')).toBe(false); // 缺少字段
      expect(CronService.validateCronExpression('0 9 * * * *')).toBe(false); // 多余字段
      expect(CronService.validateCronExpression('')).toBe(false); // 空字符串
      expect(CronService.validateCronExpression('invalid')).toBe(false);
    });
  });

  describe('Cron 日期匹配', () => {
    it('应该正确匹配分钟', () => {
      const service = new CronService();
      const matchesCron = (service as any).matchesCron.bind(service);

      const fields = {
        minute: [0],
        hour: [],
        dayOfMonth: [],
        month: [],
        dayOfWeek: [],
      };

      const dateAt0 = new Date('2024-01-01 09:00:00');
      const dateAt30 = new Date('2024-01-01 09:30:00');

      expect(matchesCron(dateAt0, fields)).toBe(true);
      expect(matchesCron(dateAt30, fields)).toBe(false);
    });

    it('应该正确匹配小时', () => {
      const service = new CronService();
      const matchesCron = (service as any).matchesCron.bind(service);

      const fields = {
        minute: [0],
        hour: [9, 18],
        dayOfMonth: [],
        month: [],
        dayOfWeek: [],
      };

      expect(matchesCron(new Date('2024-01-01 09:00:00'), fields)).toBe(true);
      expect(matchesCron(new Date('2024-01-01 18:00:00'), fields)).toBe(true);
      expect(matchesCron(new Date('2024-01-01 12:00:00'), fields)).toBe(false);
    });

    it('应该正确处理日期和星期的 OR 关系', () => {
      const service = new CronService();
      const matchesCron = (service as any).matchesCron.bind(service);

      // 每月1号 或 每周一
      const fields = {
        minute: [0],
        hour: [9],
        dayOfMonth: [1],
        month: [],
        dayOfWeek: [1],
      };

      // 2024-01-01 是周一
      expect(matchesCron(new Date('2024-01-01 09:00:00'), fields)).toBe(true); // 既是1号又是周一
      // 2024-01-08 是周一但不是1号
      expect(matchesCron(new Date('2024-01-08 09:00:00'), fields)).toBe(true); // 周一
      // 2024-02-01 是周四但是1号
      expect(matchesCron(new Date('2024-02-01 09:00:00'), fields)).toBe(true); // 1号
      // 2024-01-05 是周五（既不是1号也不是周一）
      expect(matchesCron(new Date('2024-01-05 09:00:00'), fields)).toBe(false); // 不匹配
    });
  });

  describe('下次执行时间计算', () => {
    it('应该计算 Cron 表达式的下次执行时间', () => {
      const service = new CronService();
      const calculateNextCronRun = (service as any).calculateNextCronRun.bind(service);

      const baseTime = new Date('2024-01-01 08:30:00').getTime(); // 周一

      // 每天9点
      const nextRun = calculateNextCronRun('0 9 * * *', baseTime);
      const expectedTime = new Date('2024-01-01 09:00:00').getTime();
      expect(nextRun).toBe(expectedTime);
    });

    it('应该计算第二天的执行时间', () => {
      const service = new CronService();
      const calculateNextCronRun = (service as any).calculateNextCronRun.bind(service);

      const baseTime = new Date('2024-01-01 10:00:00').getTime(); // 周一 10:00

      // 每天9点（已经错过了今天的）
      const nextRun = calculateNextCronRun('0 9 * * *', baseTime);
      const expectedTime = new Date('2024-01-02 09:00:00').getTime();
      expect(nextRun).toBe(expectedTime);
    });

    it('应该正确处理无效的 Cron 表达式', () => {
      const service = new CronService();
      const calculateNextCronRun = (service as any).calculateNextCronRun.bind(service);

      const baseTime = Date.now();
      const nextRun = calculateNextCronRun('invalid cron', baseTime);
      expect(nextRun).toBeNull();
    });

    it('应该处理复杂的 Cron 表达式', () => {
      const service = new CronService();
      const calculateNextCronRun = (service as any).calculateNextCronRun.bind(service);

      // 周一到周五的9点和18点
      const baseTime = new Date('2024-01-01 10:00:00').getTime(); // 周一
      const nextRun = calculateNextCronRun('0 9,18 * * 1-5', baseTime);
      const expectedTime = new Date('2024-01-01 18:00:00').getTime();
      expect(nextRun).toBe(expectedTime);
    });
  });

  describe('静态方法 calculateInitialNextRun', () => {
    it('应该计算一次性任务的执行时间', () => {
      const futureTime = new Date('2024-12-25 09:00:00');
      const result = CronService.calculateInitialNextRun('once', '2024-12-25 09:00:00');
      expect(result).toBe(futureTime.getTime());
    });

    it('应该计算间隔任务的执行时间', () => {
      const now = Date.now();
      const result = CronService.calculateInitialNextRun('interval', '3600'); // 1小时后
      expect(result).toBeGreaterThan(now);
      expect(result).toBeLessThanOrEqual(now + 3600 * 1000 + 1000); // 允许1秒误差
    });

    it('应该处理无效的间隔值', () => {
      const now = Date.now();
      const result = CronService.calculateInitialNextRun('interval', 'invalid');
      expect(result).toBeGreaterThanOrEqual(now);
    });

    it('应该计算 Cron 任务的下次执行时间', () => {
      const result = CronService.calculateInitialNextRun('cron', '0 9 * * *');
      expect(result).toBeGreaterThan(Date.now());
    });
  });

  describe('任务 ID 生成', () => {
    it('应该生成唯一的任务 ID', () => {
      const id1 = CronService.generateTaskId();
      const id2 = CronService.generateTaskId();

      expect(id1).toMatch(/^task-[a-z0-9]+-[a-f0-9]{8}$/);
      expect(id2).toMatch(/^task-[a-z0-9]+-[a-f0-9]{8}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('服务启动和停止', () => {
    it('应该启动服务', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
      service.start();
      expect(consoleSpy).toHaveBeenCalledWith('[CronService] Scheduler started');
      consoleSpy.mockRestore();
    });

    it('应该停止服务', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
      service.start();
      service.stop();
      expect(consoleSpy).toHaveBeenCalledWith('[CronService] Scheduler stopped');
      consoleSpy.mockRestore();
    });

    it('不应该重复启动', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      service.start();
      service.start(); // 第二次启动应该被忽略
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      setIntervalSpy.mockRestore();
    });
  });

});

describe('CronService 集成测试', () => {
  let service: CronService;

  afterEach(() => {
    // 先停止服务，再清理 mocks
    service?.stop();
    // 重置 mocks 但保留实现
    vi.clearAllMocks();
    // 确保 getDueTasks 始终返回数组，防止其他测试的异步操作出错
    vi.mocked(db.getDueTasks).mockReturnValue([]);
  });

  it('应该正确处理任务执行流程', async () => {
    // 设置 mock 返回值 - 必须在创建 service 之前设置
    const mockTask = {
      id: 'task-test-123',
      sessionId: 'session-test',
      prompt: 'Test prompt',
      scheduleType: 'once' as const,
      scheduleValue: '30',
      status: 'active' as const,
      nextRun: Date.now() - 1000, // 已经到期
      runCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 设置 mock 返回值
    vi.mocked(db.getDueTasks).mockReturnValue([mockTask]);
    vi.mocked(db.getSession).mockReturnValue({
      id: 'session-test',
      name: 'Test Session',
      systemPrompt: 'Test system prompt',
      model: 'anthropic/claude-3-5-sonnet-20241022',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isActive: true,
    });
    vi.mocked(db.getSessionMessages).mockReturnValue([]);

    // 模拟 runContainerAgent
    const { runContainerAgent } = await import('../container.js');
    vi.mocked(runContainerAgent).mockResolvedValue({
      success: true,
      content: 'Test response',
    });

    // 创建 service - 使用很长的轮询间隔，避免多次触发
    service = new CronService(600000);

    // 启动服务会触发 checkAndRunTasks
    service.start();

    // 等待异步操作完成
    await new Promise(resolve => setTimeout(resolve, 300));

    // 验证数据库操作被调用
    expect(db.getDueTasks).toHaveBeenCalled();
    expect(db.getSession).toHaveBeenCalledWith('session-test');

    // 清理
    vi.mocked(db.getDueTasks).mockReturnValue([]);
  });

  it('应该在找不到 session 时抛出错误', async () => {
    const mockTask = {
      id: 'task-test-456',
      sessionId: 'non-existent-session',
      prompt: 'Test prompt',
      scheduleType: 'once' as const,
      scheduleValue: '30',
      status: 'active' as const,
      nextRun: Date.now() - 1000,
      runCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    vi.mocked(db.getDueTasks).mockReturnValue([mockTask]);
    vi.mocked(db.getSession).mockReturnValue(undefined);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

    service = new CronService(600000);
    service.start();

    await new Promise(resolve => setTimeout(resolve, 300));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[CronService] Task task-test-456 failed:'),
      expect.any(Error)
    );

    consoleSpy.mockRestore();
    vi.mocked(db.getDueTasks).mockReturnValue([]);
  });
});
