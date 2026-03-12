/**
 * Cron Action Executor
 *
 * 职责：处理容器返回的 cron 相关工具调用
 * 从 container.ts 中提取，遵循单一职责原则
 */

import {
    ToolCall,
    ToolEvent,
    ChannelContext,
} from '../types.js';
import {
    createScheduledTask,
    listScheduledTasks,
    updateTaskStatus,
    deleteScheduledTask,
    getTaskRunLogs,
    getScheduledTask,
    updateTaskNextRun,
} from '../db/index.js';
import { CronService } from './scheduler.js';

/**
 * 安全的 JSON 序列化，处理循环引用
 */
function safeStringify(obj: unknown): string {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return '[Circular Reference]';
            }
            seen.add(value);
        }
        return value;
    });
}

/**
 * 执行单个 cron action
 */
async function executeCronAction(
    action: ToolCall,
    sessionId: string,
    channelContext?: ChannelContext,
): Promise<{ success: boolean; data?: unknown; message?: string }> {
    const { name, result, arguments: args } = action;

    // Parse result from container if provided, otherwise use arguments
    let actionData: { type?: string; payload?: Record<string, unknown> } = {};
    if (result) {
        try {
            const parsed = JSON.parse(result);
            actionData = parsed.action || parsed;
        } catch {
            // Result is not JSON, treat as plain text
        }
    }

    const payload = actionData.payload || args || {};

    switch (name) {
        case 'mcp__momoclaw_mcp__schedule_task': {
            const taskSessionId = (payload.sessionId as string) || sessionId;
            const prompt = payload.prompt as string;
            const scheduleType = payload.scheduleType as
                | 'cron'
                | 'interval'
                | 'once';
            const scheduleValue = payload.scheduleValue as string;

            if (!prompt || !scheduleType || !scheduleValue) {
                return {
                    success: false,
                    message:
                        'Missing required fields: prompt, scheduleType, scheduleValue',
                };
            }

            const taskId = CronService.generateTaskId();
            const nextRun = CronService.calculateInitialNextRun(
                scheduleType,
                scheduleValue,
            );

            const task = createScheduledTask(
                taskId,
                taskSessionId,
                prompt,
                scheduleType,
                scheduleValue,
                nextRun,
                channelContext?.type,
                channelContext?.channelId,
            );

            return {
                success: true,
                data: task,
                message: `Task ${taskId} created successfully`,
            };
        }

        case 'mcp__momoclaw_mcp__list_scheduled_tasks': {
            const targetSessionId = payload.sessionId as string | undefined;
            const tasks = listScheduledTasks(targetSessionId);
            return {
                success: true,
                data: tasks,
                message: `Found ${tasks.length} tasks`,
            };
        }

        case 'mcp__momoclaw_mcp__pause_task': {
            const taskId = payload.taskId as string;
            if (!taskId) {
                return {
                    success: false,
                    message: 'Missing required field: taskId',
                };
            }

            const success = updateTaskStatus(taskId, 'paused');
            return success
                ? { success: true, message: `Task ${taskId} paused` }
                : { success: false, message: `Task ${taskId} not found` };
        }

        case 'mcp__momoclaw_mcp__resume_task': {
            const taskId = payload.taskId as string;
            if (!taskId) {
                return {
                    success: false,
                    message: 'Missing required field: taskId',
                };
            }

            const task = getScheduledTask(taskId);
            if (!task) {
                return { success: false, message: `Task ${taskId} not found` };
            }

            // Recalculate next run time if task was completed
            const nextRun =
                task.status === 'completed'
                    ? CronService.calculateInitialNextRun(
                        task.scheduleType,
                        task.scheduleValue,
                    )
                    : task.nextRun;

            updateTaskNextRun(taskId, nextRun);
            const success = updateTaskStatus(taskId, 'active');

            return success
                ? {
                    success: true,
                    message: `Task ${taskId} resumed`,
                    data: { nextRun },
                }
                : { success: false, message: `Failed to resume task ${taskId}` };
        }

        case 'mcp__momoclaw_mcp__delete_task': {
            const taskId = payload.taskId as string;
            if (!taskId) {
                return {
                    success: false,
                    message: 'Missing required field: taskId',
                };
            }

            const success = deleteScheduledTask(taskId);
            return success
                ? { success: true, message: `Task ${taskId} deleted` }
                : { success: false, message: `Task ${taskId} not found` };
        }

        case 'mcp__momoclaw_mcp__get_task_logs': {
            const taskId = payload.taskId as string;
            const limit = Math.min(
                Math.max(parseInt(payload.limit as string) || 10, 1),
                100,
            );

            if (!taskId) {
                return {
                    success: false,
                    message: 'Missing required field: taskId',
                };
            }

            const logs = getTaskRunLogs(taskId, limit);
            return {
                success: true,
                data: logs,
                message: `Found ${logs.length} log entries`,
            };
        }

        default:
            return {
                success: false,
                message: `Unknown cron action: ${name}`,
            };
    }
}

/**
 * 处理容器返回的 cron actions
 *
 * @param actions - 工具调用列表
 * @param sessionId - 会话 ID
 * @param onToolEvent - 工具事件回调
 * @param channelContext - 频道上下文（用于任务结果推送）
 */
export async function executeCronActions(
    actions: ToolCall[],
    sessionId: string,
    onToolEvent?: (event: ToolEvent) => void,
    channelContext?: ChannelContext,
): Promise<void> {
    for (const action of actions) {
        const toolCallId = action.id || `cron-${action.name}-${Date.now()}`;
        try {
            const response = await executeCronAction(
                action,
                sessionId,
                channelContext,
            );

            if (onToolEvent) {
                onToolEvent({
                    type: 'tool_result',
                    toolCallId,
                    result: safeStringify(response),
                });
            }
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            if (onToolEvent) {
                onToolEvent({
                    type: 'tool_result',
                    toolCallId,
                    result: safeStringify({ success: false, message: error }),
                });
            }
        }
    }
}
