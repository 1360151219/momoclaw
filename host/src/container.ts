import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import {
  ContainerResult,
  PromptPayload,
  ToolEvent,
  ToolCall,
  CronAction,
} from './types.js';
import { config } from './config.js';
import {
  createScheduledTask,
  listScheduledTasks,
  updateTaskStatus,
  deleteScheduledTask,
  getTaskRunLogs,
  getScheduledTask,
  updateTaskNextRun,
} from './db.js';
import { CronService } from './cron.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRON_TOOLS = [
  'mcp__momoclaw_mcp__schedule_task',
  'mcp__momoclaw_mcp__list_scheduled_tasks',
  'mcp__momoclaw_mcp__pause_task',
  'mcp__momoclaw_mcp__resume_task',
  'mcp__momoclaw_mcp__delete_task',
  'mcp__momoclaw_mcp__get_task_logs',
];
const CONTAINER_IMAGE = 'miniclaw-agent:latest';

/**
 * 查找项目根目录
 * 从当前目录向上遍历，直到找到包含  .git 的目录
 */
function findProjectRoot(startPath: string): string {
  let currentDir = startPath;
  while (true) {
    // 检查特征文件： .git 目录
    if (existsSync(join(currentDir, '.git'))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      // 如果到达文件系统根目录仍未找到，回退到默认的相对路径假设，或者抛出错误
      // 为了安全起见，这里抛出错误，提示用户环境配置可能不正确
      throw new Error('无法找到项目根目录（未发现 .git）');
    }
    currentDir = parentDir;
  }
}

export async function runContainerAgent(
  payload: PromptPayload,
  onStream?: (chunk: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
): Promise<ContainerResult> {
  const sessionId = payload.session.id;
  const runId = randomBytes(8).toString('hex');

  // 创建临时目录用于IPC
  const tempDir = join(tmpdir(), `miniclaw-${sessionId}-${runId}`);
  const inputDir = join(tempDir, 'input');
  const outputDir = join(tempDir, 'output');

  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  // 写入prompt到输入文件
  const inputFile = join(inputDir, 'payload.json');
  writeFileSync(inputFile, JSON.stringify(payload, null, 2));

  // 准备输出文件路径
  const outputFile = join(outputDir, 'result.json');

  // 构建Docker参数
  const workspacePath = resolve(config.workspaceDir);
  // 动态查找项目根目录，而不是硬编码 '../..'
  const projectRootPath = findProjectRoot(__dirname);
  const containerWorkspace = join(tempDir, 'workspace');
  mkdirSync(containerWorkspace, { recursive: true });

  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    '--network=host',
    `--memory=2g`,
    `--cpus=2`,
    `-v`,
    `${workspacePath}:/workspace/files:rw`,
    `-v`,
    `${projectRootPath}:/workspace/files/projects/momoclaw:rw`, // 挂载项目根目录
    `-v`,
    `${inputDir}:/workspace/input:ro`,
    `-v`,
    `${outputDir}:/workspace/output:rw`,
    `-v`,
    `${containerWorkspace}:/workspace/tmp:rw`,
    '-e',
    `INPUT_FILE=/workspace/input/payload.json`,
    '-e',
    `OUTPUT_FILE=/workspace/output/result.json`,
    '-e',
    `TMP_DIR=/workspace/tmp`,
    CONTAINER_IMAGE,
    'node',
    '/app/dist/index.js',
  ];

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let buffer = '';
    const toolEventMarker = '__TOOL_EVENT__:';

    const child = spawn('docker', dockerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 流式输出
    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      buffer += chunk;

      // Parse buffer for tool events and text content
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.startsWith(toolEventMarker)) {
          // This is a tool event
          try {
            const eventJson = line.slice(toolEventMarker.length);
            const event: ToolEvent = JSON.parse(eventJson);
            if (onToolEvent) {
              onToolEvent(event);
            }
          } catch {
            // Ignore invalid tool events
          }
        } else if (line) {
          // This is regular text content
          if (onStream) {
            onStream(line + '\n');
          }
        }
      }

      // If there's remaining buffer without a newline, send it as text
      if (buffer && !buffer.includes(toolEventMarker)) {
        if (onStream) {
          onStream(buffer);
        }
        buffer = '';
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      // stderr 只记录，不输出给用户，避免干扰正常输出
      // 调试信息会在出错时一并显示
    });

    // 超时处理
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Container timeout after ${config.containerTimeout}ms`));
    }, config.containerTimeout);

    child.on('close', async (code) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;

      // Send any remaining buffer
      if (buffer && onStream) {
        onStream(buffer);
      }

      if (code !== 0) {
        resolve({
          success: false,
          content: '',
          error: `Container exited with code ${code}. stderr: ${stderr}`,
        });
        return;
      }

      // 读取结果文件
      if (!existsSync(outputFile)) {
        resolve({
          success: false,
          content: '',
          error: 'No output file generated by container',
        });
        return;
      }

      try {
        const result: ContainerResult = JSON.parse(
          readFileSync(outputFile, 'utf-8'),
        );

        const cronActions =
          result.toolCalls?.filter((call) => CRON_TOOLS.includes(call.name)) ||
          [];
        // Handle cron actions from container
        if (cronActions && cronActions.length > 0) {
          await handleCronActions(cronActions, payload.session.id, onToolEvent);
        }

        resolve(result);
      } catch (err) {
        resolve({
          success: false,
          content: '',
          error: `Failed to parse result: ${err}`,
        });
      }
      // 清理临时目录
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 忽略清理错误
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      // 清理临时目录
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
      reject(err);
    });
  });
}

/**
 * Handle cron actions from container
 */
async function handleCronActions(
  actions: ToolCall[],
  sessionId: string,
  onToolEvent?: (event: ToolEvent) => void,
): Promise<void> {
  for (const action of actions) {
    const toolCallId = action.id || `cron-${action.name}-${Date.now()}`;
    try {
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

      const actionType = actionData.type;
      const payload = actionData.payload || args || {};

      let response: { success: boolean; data?: unknown; message?: string };

      switch (name) {
        case 'mcp__momoclaw_mcp__schedule_task': {
          // Create a new scheduled task
          const taskSessionId = (payload.sessionId as string) || sessionId;
          const prompt = payload.prompt as string;
          const scheduleType = payload.scheduleType as
            | 'cron'
            | 'interval'
            | 'once';
          const scheduleValue = payload.scheduleValue as string;

          if (!prompt || !scheduleType || !scheduleValue) {
            response = {
              success: false,
              message:
                'Missing required fields: prompt, scheduleType, scheduleValue',
            };
            break;
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
          );

          response = {
            success: true,
            data: task,
            message: `Task ${taskId} created successfully`,
          };
          break;
        }

        case 'mcp__momoclaw_mcp__list_scheduled_tasks': {
          // List scheduled tasks
          const targetSessionId = payload.sessionId as string | undefined;
          const tasks = listScheduledTasks(targetSessionId);
          response = {
            success: true,
            data: tasks,
            message: `Found ${tasks.length} tasks`,
          };
          break;
        }

        case 'mcp__momoclaw_mcp__pause_task': {
          // Pause a task
          const taskId = payload.taskId as string;
          if (!taskId) {
            response = {
              success: false,
              message: 'Missing required field: taskId',
            };
            break;
          }

          const success = updateTaskStatus(taskId, 'paused');
          response = success
            ? { success: true, message: `Task ${taskId} paused` }
            : { success: false, message: `Task ${taskId} not found` };
          break;
        }

        case 'mcp__momoclaw_mcp__resume_task': {
          // Resume a task
          const taskId = payload.taskId as string;
          if (!taskId) {
            response = {
              success: false,
              message: 'Missing required field: taskId',
            };
            break;
          }

          const task = getScheduledTask(taskId);
          if (!task) {
            response = { success: false, message: `Task ${taskId} not found` };
            break;
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

          response = success
            ? {
                success: true,
                message: `Task ${taskId} resumed`,
                data: { nextRun },
              }
            : { success: false, message: `Failed to resume task ${taskId}` };
          break;
        }

        case 'mcp__momoclaw_mcp__delete_task': {
          // Delete a task
          const taskId = payload.taskId as string;
          if (!taskId) {
            response = {
              success: false,
              message: 'Missing required field: taskId',
            };
            break;
          }

          const success = deleteScheduledTask(taskId);
          response = success
            ? { success: true, message: `Task ${taskId} deleted` }
            : { success: false, message: `Task ${taskId} not found` };
          break;
        }

        case 'mcp__momoclaw_mcp__get_task_logs': {
          // Get task execution logs
          const taskId = payload.taskId as string;
          const limit = Math.min(
            Math.max(parseInt(payload.limit as string) || 10, 1),
            100,
          );

          if (!taskId) {
            response = {
              success: false,
              message: 'Missing required field: taskId',
            };
            break;
          }

          const logs = getTaskRunLogs(taskId, limit);
          response = {
            success: true,
            data: logs,
            message: `Found ${logs.length} log entries`,
          };
          break;
        }

        default:
          response = {
            success: false,
            message: `Unknown cron action: ${name}`,
          };
      }

      if (onToolEvent) {
        onToolEvent({
          type: 'tool_result',
          toolCallId,
          result: JSON.stringify(response),
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (onToolEvent) {
        onToolEvent({
          type: 'tool_result',
          toolCallId,
          result: JSON.stringify({ success: false, message: error }),
        });
      }
    }
  }
}

export function checkDockerAvailable(): boolean {
  try {
    const result = spawn('docker', ['--version'], { stdio: 'pipe' });
    return result.pid !== undefined;
  } catch {
    return false;
  }
}

export async function buildContainerImage(): Promise<boolean> {
  return new Promise((res, rej) => {
    // 使用统一的 findProjectRoot 查找根目录，然后拼接 container 路径
    const rootDir = findProjectRoot(__dirname);
    const containerDir = join(rootDir, 'container');

    const child = spawn('docker', ['build', '-t', CONTAINER_IMAGE, '.'], {
      cwd: containerDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    (child as any).on('close', (code: number) => {
      res(code === 0);
    });

    (child as any).on('error', rej);
  });
}
