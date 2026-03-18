import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import {
  ContainerResult,
  PromptPayload,
  ToolEvent,
  ChannelContext,
} from './types.js';
import { config } from './config.js';
import { executeCronActions } from './cron/executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  writeFileSync(inputFile, safeStringify(payload));

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
    `CONTEXT7_API_KEY=${config.context7ApiKey}`,
    '-e',
    `GITHUB_TOKEN=${config.githubToken}`,
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
        const errorMsg = `Container exited with code ${code}.\nStderr: ${stderr}\nStdout (last 500 chars): ${stdout.slice(-500)}`;
        console.error(errorMsg);
        resolve({
          success: false,
          content: '',
          error: errorMsg,
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

        // Handle cron actions from container (schedule, list, pause, resume, delete, logs)
        const cronToolPrefix = 'mcp__momoclaw_mcp__';
        const cronActions =
          result.toolCalls?.filter(
            (call) =>
              call.name.startsWith(cronToolPrefix) &&
              [
                'schedule_task',
                'list_scheduled_tasks',
                'pause_task',
                'resume_task',
                'delete_task',
                'get_task_logs',
              ].includes(call.name.slice(cronToolPrefix.length)),
          ) || [];
        if (cronActions.length > 0) {
          await executeCronActions(
            cronActions,
            payload.session.id,
            onToolEvent,
            payload.channelContext,
          );
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

    child.on('close', (code: number | null) => {
      res(code === 0);
    });

    child.on('error', rej);
  });
}
