import { spawn } from 'child_process';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  readdirSync,
} from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { ContainerResult, PromptPayload, ToolEvent } from './types.js';
import { config, getApiConfig } from './config.js';
import {
  findProjectRoot,
  ensureDirWithPerms,
  safeStringify,
} from './hooks/utils.js';
import { sessionQueue } from './core/sessionQueue.js';
import { getSession } from './db/sessions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Constants ---
const CONTAINER_IMAGE = 'momoclaw-agent:latest';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30分钟无新对话则销毁
const CLEANUP_INTERVAL_MS = 60 * 1000; // 每分钟检查一次

// --- Types ---
interface ActiveContainer {
  sessionId: string;
  containerName: string;
  sessionDir: string;
  lastAccessed: number;
  isDestroying?: boolean;
}

// --- Container Manager ---
/**
 * 负责管理 Docker 容器的生命周期，包括启动、保活、超时清理和进程退出时的销毁
 */
class ContainerManager {
  private activeContainers = new Map<string, ActiveContainer>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.cleanupInterval = setInterval(
      () => this.cleanupIdleContainers(),
      CLEANUP_INTERVAL_MS,
    );
    this.registerProcessHandlers();
  }

  private cleanupIdleContainers() {
    const now = Date.now();
    for (const [sessionId, container] of this.activeContainers.entries()) {
      // Check if container is already being destroyed to avoid duplicate runs
      if (container.isDestroying) continue;

      if (now - container.lastAccessed > IDLE_TIMEOUT_MS) {
        console.log(
          `[ContainerManager] 容器 ${container.containerName} 超过 ${IDLE_TIMEOUT_MS / 60000} 分钟空闲，准备触发闲置回收...`,
        );
        container.isDestroying = true; // Mark as being destroyed

        // 异步执行，不阻塞后续容器的检查
        (async () => {
          try {
            await this.performAutoSummary(sessionId, container);
          } catch (error) {
            console.error(`[ContainerManager] 容器闲置收尾执行失败:`, error);
          } finally {
            this.destroyContainer(container);
            this.activeContainers.delete(sessionId);
          }
        })();
      }
    }
  }

  /**
   * 在容器销毁前触发收尾 SOP，利用容器内的 Claude Agent 自动总结和沉淀
   */
  private async performAutoSummary(
    sessionId: string,
    container: ActiveContainer,
  ) {
    // 将收尾 SOP 放入 sessionQueue，确保不与用户的并发消息冲突
    await sessionQueue.enqueue(sessionId, async () => {
      const session = getSession(sessionId);
      if (!session) return;

      console.log(
        `\n[Auto Summary] 触发容器 ${container.containerName} 的收尾 SOP...`,
      );

      const apiConfig = getApiConfig(config, session.model || undefined);

      // 我们不通过 processChat，而是直接调用 agentRunner.run，
      // 这样这条指令和回复就不会污染数据库中的 user/assistant 聊天记录。
      const payload: PromptPayload = {
        session,
        messages: [],
        userInput: `[System] idle-sop — 当前会话闲置超时，即将被系统回收。请立即启用你的 idle-sop skill。`,
        apiConfig,
      };

      try {
        // 使用底层的 run，避免循环依赖，直接让 runner 去跑
        const result = await agentRunner.run(payload);
        if (result.success) {
          console.log(
            `[Auto Summary] 容器 ${container.containerName} 收尾完成: ${result.content.substring(0, 100).replace(/\n/g, ' ')}...`,
          );
        } else {
          console.log(
            `[Auto Summary] 容器 ${container.containerName} 收尾失败或超时: ${result.error}`,
          );
        }
      } catch (err) {
        console.error(
          `[Auto Summary] 容器 ${container.containerName} 收尾发生异常:`,
          err,
        );
      }
    });
  }

  private registerProcessHandlers() {
    process.on('exit', () => this.destroyAllContainers());
    process.on('SIGINT', () => process.exit());
    process.on('SIGTERM', () => process.exit());
  }

  private destroyContainer(container: ActiveContainer) {
    try {
      spawn('docker', ['rm', '-f', container.containerName]);
      rmSync(container.sessionDir, { recursive: true, force: true });
    } catch (err) {
      console.error(
        `[ContainerManager] 清理容器 ${container.containerName} 失败:`,
        err,
      );
    }
  }

  public destroyAllContainers() {
    for (const container of this.activeContainers.values()) {
      this.destroyContainer(container);
    }
    this.activeContainers.clear();
    clearInterval(this.cleanupInterval);
  }

  /**
   * 递归设置目录和文件权限，确保容器内不同 UID 的用户也能读写
   */
  private chmodRecursive(dirPath: string): void {
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        try {
          if (entry.isDirectory()) {
            chmodSync(fullPath, 0o777);
            this.chmodRecursive(fullPath);
          } else {
            chmodSync(fullPath, 0o666);
          }
        } catch {
          // 跳过无法修改权限的文件
        }
      }
    } catch {
      // 跳过无法读取的目录
    }
  }

  public async getOrStartContainer(
    sessionId: string,
  ): Promise<ActiveContainer> {
    const existing = this.activeContainers.get(sessionId);
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing;
    }

    const workspacePath = resolve(config.workspaceDir);
    const projectRootPath = findProjectRoot(__dirname);
    const tempDir = join(workspacePath, 'temp');

    const sessionDir = join(tempDir, `momoclaw-session-${sessionId}`);
    const claudeDir = join(dirname(config.dbPath), 'claude-sessions');

    [workspacePath, tempDir, sessionDir, claudeDir].forEach((dir) =>
      ensureDirWithPerms(dir),
    );

    // 确保 workspace 下的关键子目录存在且有正确权限
    // 避免容器内 node 用户因 UID 不匹配导致 Permission denied
    const criticalSubDirs = [
      'memory',
      'memory/sessions',
      'temp',
      'credentials',
      'temp/feishu-images',
      'temp/downloads',
    ];
    for (const sub of criticalSubDirs) {
      ensureDirWithPerms(join(workspacePath, sub));
    }

    // 递归修正 workspace 目录下所有文件和文件夹的权限
    // 解决 Linux 服务器上宿主机 UID 与容器 node 用户 UID 不匹配的问题
    try {
      this.chmodRecursive(workspacePath);
    } catch (err) {
      console.warn(
        '[ContainerManager] 递归修正 workspace 权限时出现警告:',
        err,
      );
    }

    // Ensure .claude.json exists before mounting to avoid Docker creating it as a directory
    const claudeJsonPath = join(claudeDir, '.claude.json');
    if (!existsSync(claudeJsonPath)) {
      writeFileSync(claudeJsonPath, '{}');
    }
    chmodSync(claudeJsonPath, 0o666);

    const sanitizedSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const containerName = `momoclaw-${sanitizedSessionId}`;

    // 清理可能存在的残留同名容器
    try {
      spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    } catch {}

    const dockerArgs = [
      'run',
      '-d',
      '--name',
      containerName,
      '--add-host=host.docker.internal:host-gateway', // 兼容 linux
      `--memory=2g`,
      `--cpus=2`,
      `-v`,
      `${workspacePath}:/workspace/files:rw`,
      `-v`,
      `${projectRootPath}:/workspace/files/projects/momoclaw:rw`,
      `-v`,
      `${sessionDir}:/workspace/session_tmp:rw`,
      `-v`,
      `${claudeDir}:/home/node/.claude:rw`,
      `-v`,
      `${claudeJsonPath}:/home/node/.claude.json:rw`,
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
          reject(
            new Error(
              `Failed to start container ${containerName}. Code: ${code}, Stderr: ${stderr}, Stdout: ${stdout}`,
            ),
          );
        } else {
          const activeContainer = {
            sessionId,
            containerName,
            sessionDir,
            lastAccessed: Date.now(),
          };
          this.activeContainers.set(sessionId, activeContainer);
          console.log(
            `[ContainerManager] 容器 ${containerName} 已启动，后台保活中...`,
          );
          resolve(activeContainer);
        }
      });
      child.on('error', reject);
    });
  }
}

// --- Agent Runner ---
/**
 * 负责在指定的 Docker 容器中执行具体的代理任务，并处理输入输出
 */
class AgentRunner {
  private manager: ContainerManager;

  constructor(manager: ContainerManager) {
    this.manager = manager;
  }

  public async run(
    payload: PromptPayload,
    onStream?: (chunk: string) => void,
    onToolEvent?: (event: ToolEvent) => void,
  ): Promise<ContainerResult> {
    const sessionId = payload.session.id;
    const runId = randomBytes(8).toString('hex');

    let activeContainer: ActiveContainer;
    try {
      activeContainer = await this.manager.getOrStartContainer(sessionId);
    } catch (err: any) {
      return {
        success: false,
        content: '',
        error: `Container startup failed: ${err.message}`,
      };
    }

    const runDir = join(activeContainer.sessionDir, runId);
    const inputDir = join(runDir, 'input');
    const outputDir = join(runDir, 'output');
    const containerWorkspace = join(runDir, 'workspace');

    [runDir, inputDir, outputDir, containerWorkspace].forEach((dir) =>
      ensureDirWithPerms(dir),
    );

    const inputFile = join(inputDir, 'payload.json');
    writeFileSync(inputFile, safeStringify(payload));
    chmodSync(inputFile, 0o777);

    const outputFile = join(outputDir, 'result.json');
    // outputFile will be created by the container, no need to chmodSync here

    const hostMcpPort = config.hostMcpPort;
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

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        buffer += chunk;

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.startsWith(toolEventMarker)) {
            try {
              const eventJson = line.slice(toolEventMarker.length);
              const event: ToolEvent = JSON.parse(eventJson);
              if (onToolEvent) {
                onToolEvent(event);
              }
            } catch {}
          } else if (line) {
            if (onStream) {
              onStream(line + '\n');
            }
          }
        }

        if (buffer && !buffer.includes(toolEventMarker)) {
          if (onStream) {
            onStream(buffer);
          }
          buffer = '';
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new Error(`Container timeout after ${config.containerTimeout}ms`),
        );
      }, config.containerTimeout);

      child.on('close', (code) => {
        clearTimeout(timeoutId);

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
        } finally {
          this.cleanupRunDir(runDir);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        this.cleanupRunDir(runDir);
        reject(err);
      });
    });
  }

  private cleanupRunDir(runDir: string) {
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {}
  }
}

// --- Docker Environment Check ---
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

// --- Module Exports ---
const globalManager = new ContainerManager();
const agentRunner = new AgentRunner(globalManager);

/**
 * 在容器中运行代理任务的入口函数
 */
export function runContainerAgent(
  payload: PromptPayload,
  onStream?: (chunk: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
): Promise<ContainerResult> {
  return agentRunner.run(payload, onStream, onToolEvent);
}
