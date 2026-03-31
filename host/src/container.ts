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

// --- 容器保活与超时销毁机制 ---
interface ActiveContainer {
  sessionId: string;
  containerName: string;
  sessionDir: string;
  lastAccessed: number;
}

const activeContainers = new Map<string, ActiveContainer>();
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30分钟无新对话则销毁

// 定时清理过期容器
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, container] of activeContainers.entries()) {
    if (now - container.lastAccessed > IDLE_TIMEOUT_MS) {
      console.log(
        `[ContainerManager] 容器 ${container.containerName} 超过 ${IDLE_TIMEOUT_MS / 60000} 分钟空闲，准备销毁...`,
      );
      try {
        spawn('docker', ['rm', '-f', container.containerName]);
        rmSync(container.sessionDir, { recursive: true, force: true });
      } catch (err) {
        console.error(
          `[ContainerManager] 清理容器 ${container.containerName} 失败:`,
          err,
        );
      }
      activeContainers.delete(sessionId);
    }
  }
}, 60 * 1000); // 每分钟检查一次

// 进程退出时清理所有活跃容器
process.on('exit', () => {
  for (const container of activeContainers.values()) {
    try {
      spawn('docker', ['rm', '-f', container.containerName]);
      rmSync(container.sessionDir, { recursive: true, force: true });
    } catch {}
  }
});

process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

async function getOrStartContainer(
  sessionId: string,
): Promise<ActiveContainer> {
  const existing = activeContainers.get(sessionId);
  if (existing) {
    existing.lastAccessed = Date.now();
    return existing;
  }

  const sessionDir = join(tmpdir(), `miniclaw-session-${sessionId}`);
  mkdirSync(sessionDir, { recursive: true });
  
  // Sanitize Docker container name to only contain valid characters [a-zA-Z0-9][a-zA-Z0-9_.-]
  const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const containerName = `miniclaw-${sanitizedSessionId}`;

  const workspacePath = resolve(config.workspaceDir);
  const projectRootPath = findProjectRoot(__dirname);

  // 清理可能存在的残留同名容器
  try {
    spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
  } catch {}

  const claudeDir = join(dirname(config.dbPath), 'claude-sessions');
  mkdirSync(claudeDir, { recursive: true });

  const dockerArgs = [
    'run',
    '-d',
    '--name',
    containerName,
    '--add-host=host.docker.internal:host-gateway', // 兼容 linux
    `--memory=2g`,
    `--cpus=2`,
    `-v`,
    `${workspacePath}:/workspace/files:rw`, // 挂载工作目录
    `-v`,
    `${projectRootPath}:/workspace/files/projects/momoclaw:rw`, // 挂载momoclaw项目根目录
    `-v`,
    `${sessionDir}:/workspace/session_tmp:rw`, // 挂载会话临时目录
    `-v`,
    `${claudeDir}:/home/node/.claude:rw`, // 挂载Claude会话目录
    CONTAINER_IMAGE,
    'tail',
    '-f',
    '/dev/null',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerArgs);
    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to start container ${containerName}. Code: ${code}, Stderr: ${stderr}, Stdout: ${stdout}`));
      } else {
        const activeContainer = {
          sessionId,
          containerName,
          sessionDir,
          lastAccessed: Date.now(),
        };
        activeContainers.set(sessionId, activeContainer);
        console.log(
          `[ContainerManager] 容器 ${containerName} 已启动，后台保活中...`,
        );
        resolve(activeContainer);
      }
    });
    child.on('error', reject);
  });
}

export async function runContainerAgent(
  payload: PromptPayload,
  onStream?: (chunk: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
): Promise<ContainerResult> {
  const sessionId = payload.session.id;
  const runId = randomBytes(8).toString('hex');

  let activeContainer: ActiveContainer;
  try {
    activeContainer = await getOrStartContainer(sessionId);
  } catch (err: any) {
    return {
      success: false,
      content: '',
      error: `Container startup failed: ${err.message}`,
    };
  }

  // 创建本次运行的临时目录
  const runDir = join(activeContainer.sessionDir, runId);
  const inputDir = join(runDir, 'input');
  const outputDir = join(runDir, 'output');
  const containerWorkspace = join(runDir, 'workspace');

  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(containerWorkspace, { recursive: true });

  // 写入prompt到输入文件
  const inputFile = join(inputDir, 'payload.json');
  writeFileSync(inputFile, safeStringify(payload));

  // 准备输出文件路径
  const outputFile = join(outputDir, 'result.json');

  // 构建 docker exec 参数
  // 由于在 Mac 上我们之前在启动容器时已经配置了 --network=host，在某些环境下(如 OrbStack)可以支持 127.0.0.1
  // 但为了最大的兼容性，我们可以尝试传递宿主机在 Docker 桥接网络中的 IP。
  // 不过我们现在是在使用 Docker Desktop/OrbStack 的 host.docker.internal 约定
  const hostMcpPort = (await import('./index.js')).hostMcpPort;
  // 注意，Docker 在 --network=host 时，host.docker.internal 可能无法解析。
  // 我们改用宿主机实际的 IP 或者通过环境变量获取。由于宿主机的 IP 可能变化，这里可以依赖我们在启动容器时挂载的环境
  const hostMcpUrl = `http://host.docker.internal:${hostMcpPort}/sse`;
  const dockerArgs = [
    'exec',
    '-i',
    '-e',
    `INPUT_FILE=/workspace/session_tmp/${runId}/input/payload.json`,
    '-e',
    `OUTPUT_FILE=/workspace/session_tmp/${runId}/output/result.json`,
    '-e',
    `CONTEXT7_API_KEY=${config.context7ApiKey}`,
    '-e',
    `GITHUB_TOKEN=${config.githubToken}`,
    '-e',
    `TMP_DIR=/workspace/session_tmp/${runId}/workspace`,
    '-e',
    `HOST_MCP_URL=${hostMcpUrl}`,
    '-u',
    'node',
    activeContainer.containerName,
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
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        // 忽略清理错误
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      // 清理临时目录
      try {
        rmSync(runDir, { recursive: true, force: true });
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
