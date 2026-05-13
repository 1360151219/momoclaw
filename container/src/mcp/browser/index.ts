import path from 'path';
import { spawn } from 'child_process';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { Browser, BrowserContext, Page } from 'playwright-core';

import {
  DEFAULT_CDP_ENDPOINT,
  REALISTIC_USER_AGENT,
  STEALTH_CONTEXT_OPTIONS,
  WORKSPACE_DIR,
} from './constants.js';
import { StepSchema } from './types.js';
import {
  clearChromiumProfileLocks,
  clearChromiumState,
  ensureDir,
  findChromiumExecutable,
  isPidAlive,
  readChromiumState,
  waitForPidExit,
  writeChromiumState,
} from './processManager.js';
import { readGlobalBlocklist, writeGlobalBlocklist } from './security.js';
import { connectBrowser, applyLowMemoryRouting, runSteps } from './engine.js';

/**
 * 把对象包装成统一的 MCP 文本结果。
 *
 * @param payload - 任意可 JSON 序列化对象
 * @returns MCP text content
 */
function toJsonResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * 等待一段时间。
 *
 * @param ms - 毫秒
 * @returns Promise
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询等待 CDP HTTP 端点就绪。
 *
 * 这里只做一件事：检查 `/json/version` 是否可访问。
 * 超时默认 30 秒（容器环境下 Chrome 冷启动可能较慢）。
 *
 * @param cdpEndpoint - CDP 地址，例如 `http://127.0.0.1:9222`
 * @param timeoutMs - 最大等待时间（毫秒），默认 30000
 * @returns 是否已就绪
 */
async function waitForCdpReady(
  cdpEndpoint: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpEndpoint}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // 浏览器还没准备好，继续等待下一轮探测。
    }

    await sleep(500);
  }

  return false;
}

/**
 * 读取仍然可用的 Chromium 状态。
 *
 * 如果状态文件存在但进程已经死亡，会顺手清掉状态文件，
 * 避免后续调用被脏状态误导。
 *
 * @returns 存活状态或 undefined
 */
function readAliveChromiumState() {
  const state = readChromiumState();
  if (!state) {
    return undefined;
  }

  if (!isPidAlive(state.pid)) {
    clearChromiumState();
    return undefined;
  }

  return state;
}

/**
 * 管理当前 MCP 进程内缓存的浏览器连接（browser / context / page）。
 *
 * 封装目标：
 * 1. 将分散的模块级 let 变量集中管理，避免任意函数随意读写
 * 2. 统一连接的获取、复用、丢弃逻辑
 * 3. 为未来扩展（如多页面/多端点）预留结构
 *
 * 注意：
 * - close() 只丢弃 JS 引用，不调用 browser.close()，
 *   因为 Browser 来自 connectOverCDP()，关闭它会直接杀死外部 Chromium
 * - 真正的连接释放交给 Node 进程退出时自动完成
 */
class SessionManager {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private endpoint: string | undefined;

  /**
   * 丢弃当前缓存的所有连接引用。
   */
  async close(): Promise<void> {
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.endpoint = undefined;
  }

  /**
   * 获取一个可复用的页面实例。
   *
   * 设计策略：
   * 1. 如果 endpoint 变化，先丢弃旧连接
   * 2. 如果已有页面仍然可用，直接复用
   * 3. 连接 CDP 后优先复用默认 context 和第一个 page
   *
   * @param cdpEndpoint - 要连接的 CDP 地址
   * @returns 可复用的页面对象
   */
  async getPage(cdpEndpoint: string): Promise<Page> {
    // endpoint 变化时丢弃旧连接
    if (this.endpoint && this.endpoint !== cdpEndpoint) {
      await this.close();
    }

    // 已有页面仍可用则直接复用
    if (this.page) {
      try {
        await this.page.evaluate(() => true);
        return this.page;
      } catch {
        await this.close();
      }
    }

    // 新建连接，优先复用默认 context 和第一个 page
    this.browser = await connectBrowser(cdpEndpoint);
    this.context =
      this.browser.contexts()[0] ??
      (await this.browser.newContext(STEALTH_CONTEXT_OPTIONS));
    this.page =
      this.context.pages()[0] ?? (await this.context.newPage());
    this.endpoint = cdpEndpoint;

    return this.page;
  }
}

/** 当前 MCP 进程内的浏览器会话管理器（单例）。 */
const session = new SessionManager();

/**
 * 关闭 Browser MCP 在当前 Node 进程内持有的 Playwright 连接。
 *
 * 背景：
 * - Host 会通过 `docker exec` 在"长生命周期容器"里反复启动 `node /app/dist/index.js`
 * - 但每次 exec 内的 Node 进程都必须尽快退出，否则 Host 侧会一直卡在等待 `docker exec` 结束
 * - Playwright 的 CDP 连接如果不关闭，会保持 WebSocket 句柄，导致 Node 事件循环无法自然退出
 *
 * 注意：
 * - 这里只清理当前进程内的引用，不会停止 Chromium 进程（Chromium 允许跨多次 exec 复用登录态）
 *
 * @returns Promise<void>
 */
export async function shutdownBrowserMcp(): Promise<void> {
  await session.close();
}

/**
 * 创建 Browser MCP。
 *
 * 改造原则：
 * 1. 文件路径与核心常量统一复用 `constants.ts`
 * 2. 浏览器执行统一复用 `engine.ts + types.ts`
 * 3. 不再保留业务写死步骤工具，统一通过 `browser_run` 执行 AI 动态生成的步骤
 *
 * 保留工具：
 * - `browser_chromium_status`
 * - `browser_start_chromium`
 * - `browser_stop_chromium`
 * - `browser_get_blocklist`
 * - `browser_set_blocklist`
 * - `browser_run`
 *
 * @returns Browser MCP server
 */
export function createBrowserMcpServer() {
  return createSdkMcpServer({
    name: 'momoclaw-browser-mcp',
    version: '2.2.0',
    tools: [
      tool(
        'browser_chromium_status',
        '查询当前持久化 Chromium 的运行状态。请严格检查返回结果中的 `running` 字段。',
        {},
        async () => {
          const state = readAliveChromiumState();

          return toJsonResult(
            state
              ? {
                  ok: true,
                  running: true,
                  defaultCdpEndpoint: DEFAULT_CDP_ENDPOINT,
                  workspaceDir: WORKSPACE_DIR,
                  state,
                }
              : {
                  ok: true,
                  running: false,
                },
          );
        },
      ),
      tool(
        'browser_start_chromium',
        [
          '启动一个 headless Chromium，并开启 CDP 端口供 `browser_run` 连接。',
          '这个版本遵守最小化原则：不做额外僵尸进程清理，只负责启动、等待就绪、写状态文件。',
        ].join('\n'),
        {
          port: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('远程调试端口，默认 9222。'),
          keepExisting: z
            .boolean()
            .optional()
            .describe('如果同端口浏览器已存在，是否直接复用，默认 true。'),
        },
        async ({ port, keepExisting }) => {
          const debugPort = port ?? 9222;
          const reuse = keepExisting ?? true;
          const userDataDirRel = path.join(
            'temp',
            'browser',
            `chromium-profile-${debugPort}`,
          );
          const userDataDirAbs = path.join(WORKSPACE_DIR, userDataDirRel);

          ensureDir(userDataDirAbs);

          const existing = readAliveChromiumState();
          if (existing && existing.port === debugPort && reuse) {
            return toJsonResult({ ok: true, reused: true, ...existing });
          }

          if (existing && existing.port === debugPort && !reuse) {
            try {
              process.kill(existing.pid, 'SIGTERM');
            } catch {
              // ignore
            }

            const exited = await waitForPidExit(existing.pid, 5_000);
            if (!exited) {
              try {
                process.kill(existing.pid, 'SIGKILL');
              } catch {
                // ignore
              }
              await waitForPidExit(existing.pid, 2_000);
            }

            clearChromiumState();
            await session.close();
          }

          // 走到这里时，已确认没有活着的同端口 Chromium（上方已处理 existing 分支），
          // 所以无条件清理残留的 Singleton 锁文件，避免旧容器 hostname 残留导致
          // "The profile appears to be in use by another Chromium process on another computer" 报错。
          clearChromiumProfileLocks(userDataDirAbs);

          const executablePath = findChromiumExecutable();
          if (!executablePath) {
            return toJsonResult({
              ok: false,
              error: 'Chromium executable not found in container.',
              hint: 'Install chromium in the image or set CHROMIUM_PATH.',
            });
          }

          const args = [
            '--headless=new',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-sync',
            '--mute-audio',
            '--window-size=1440,900',
            '--remote-debugging-address=0.0.0.0',
            `--remote-debugging-port=${debugPort}`,
            `--user-data-dir=${userDataDirAbs}`,
            `--user-agent=${REALISTIC_USER_AGENT}`,
          ];

          // stderr 用 pipe 捕获，以便 CDP 未就绪时能输出 Chrome 的真实错误信息。
          const child = spawn(executablePath, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
            detached: true,
          });

          // 收集 stderr 输出（最多保留尾部 2KB，避免内存膨胀）。
          let stderrBuf = '';
          child.stderr?.on('data', (chunk: Buffer) => {
            stderrBuf += chunk.toString();
            if (stderrBuf.length > 2048) {
              stderrBuf = stderrBuf.slice(-2048);
            }
          });

          child.unref();

          const pid = child.pid ?? -1;
          if (pid <= 0) {
            return toJsonResult({
              ok: false,
              error: 'Failed to spawn Chromium process.',
            });
          }

          const cdpEndpoint = `http://127.0.0.1:${debugPort}`;
          const ready = await waitForCdpReady(cdpEndpoint);

          // 探测完成后停止监听 stderr，避免 detached 进程句柄泄漏。
          child.stderr?.removeAllListeners('data');
          child.stderr?.destroy();

          if (!ready) {
            return toJsonResult({
              ok: false,
              error: 'Chromium started but CDP endpoint was not ready in time.',
              pid,
              cdpEndpoint,
              // 附带 Chrome 的 stderr 输出，方便定位根因
              chromiumStderr: stderrBuf.trim() || '(no stderr output)',
            });
          }

          const state = {
            pid,
            port: debugPort,
            cdpEndpoint,
            userDataDirRel,
            startedAt: Date.now(),
          };
          writeChromiumState(state);

          return toJsonResult({
            ok: true,
            reused: false,
            ...state,
          });
        },
      ),
      tool(
        'browser_stop_chromium',
        '停止由 `browser_start_chromium` 启动的 Chromium，并清理状态文件；不会删除 profile 目录，但会在浏览器退出后清理残留的单例锁文件。',
        {
          force: z
            .boolean()
            .optional()
            .describe('是否使用 SIGKILL 强制停止，默认 false。'),
        },
        async ({ force }) => {
          const state = readAliveChromiumState();
          if (!state) {
            return toJsonResult({ ok: true, stopped: false });
          }

          const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
          try {
            process.kill(state.pid, signal);
          } catch {
            // ignore
          } finally {
            await waitForPidExit(state.pid, force ? 2_000 : 5_000).catch(
              () => false,
            );
            clearChromiumProfileLocks(
              path.join(WORKSPACE_DIR, state.userDataDirRel),
            );
            clearChromiumState();
            await session.close();
          }

          return toJsonResult({
            ok: true,
            stopped: true,
            pid: state.pid,
          });
        },
      ),
      tool(
        'browser_get_blocklist',
        '读取全局 blocklist（存放在 workspace/credentials/browser/blocklist.json）。',
        {},
        async () => {
          return toJsonResult({
            domains: readGlobalBlocklist(),
          });
        },
      ),
      tool(
        'browser_set_blocklist',
        '写入全局 blocklist。支持 `example.com` 或 `*.example.com`。',
        {
          domains: z.array(z.string()).describe('要屏蔽的域名列表。'),
        },
        async ({ domains }) => {
          writeGlobalBlocklist(domains);
          return toJsonResult({
            ok: true,
            domains,
          });
        },
      ),
      tool(
        'browser_run',
        [
          '通过 CDP 连接一个已存在的 Chrome/Chromium，然后执行受限步骤 DSL。',
          'AI 需要自己为当前任务动态生成 steps，MCP 只负责执行这些步骤。',
          '如果当前容器内已通过 `browser_start_chromium` 启动了浏览器，会优先自动使用它的 CDP 地址。',
          '默认开启低内存路由：始终拦截 font/media；当 blockImages=true 时还会额外拦截图片。',
          '为保证安全，导航步骤会自动校验 URL，并应用全局或本次传入的 blocklist。',
          '推荐步骤模式：goto -> waitForSelector/click/fill/press/scroll/sleep -> extract/screenshot。',
        ].join('\n'),
        {
          cdpEndpoint: z
            .string()
            .optional()
            .describe('可选，显式指定 CDP 地址。'),
          steps: z
            .array(StepSchema)
            .describe('由 AI 动态生成、再由 MCP 执行的步骤列表。'),
          blockDomains: z
            .array(z.string())
            .optional()
            .describe('本次临时覆盖的 blocklist；不传则使用全局 blocklist。'),
          blockImages: z
            .boolean()
            .optional()
            .describe('是否额外拦截图片资源，默认 false。'),
          resetPage: z
            .boolean()
            .optional()
            .describe('执行前是否先跳转到 about:blank，默认 false。'),
          defaultTimeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('为缺少 timeoutMs 的步骤补默认超时，默认 30000。'),
        },
        async ({
          cdpEndpoint,
          steps,
          blockDomains,
          blockImages,
          resetPage,
          defaultTimeoutMs,
        }) => {
          const localState = readAliveChromiumState();
          const resolvedEndpoint =
            cdpEndpoint ?? localState?.cdpEndpoint ?? DEFAULT_CDP_ENDPOINT;
          const effectiveBlockDomains = blockDomains?.length
            ? blockDomains
            : readGlobalBlocklist();
          const effectiveTimeoutMs = defaultTimeoutMs ?? 30_000;

          const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const artifactDirRel = path.join('temp', 'browser', runId);
          const artifactDirAbs = path.join(WORKSPACE_DIR, artifactDirRel);
          ensureDir(artifactDirAbs);

          try {
            const page = await session.getPage(resolvedEndpoint);
            await page.unroute('**/*').catch(() => {});
            await applyLowMemoryRouting(page, {
              blockImages: blockImages ?? false,
            });

            if (resetPage) {
              await page.goto('about:blank').catch(() => {});
            }

            const normalizedSteps = steps.map((step) => {
              if ('timeoutMs' in step && step.timeoutMs == null) {
                return {
                  ...step,
                  timeoutMs: effectiveTimeoutMs,
                };
              }
              return step;
            });

            const { screenshots, extracted } = await runSteps({
              page,
              steps: normalizedSteps,
              blockDomains: effectiveBlockDomains,
              artifactDirRel,
            });

            if (screenshots.length === 0) {
              const screenshotRel = path.join(artifactDirRel, 'final.png');
              await page.screenshot({
                path: path.join(WORKSPACE_DIR, screenshotRel),
                fullPage: true,
              });
              screenshots.push(screenshotRel);
            }

            return toJsonResult({
              ok: true,
              cdpEndpoint: resolvedEndpoint,
              blockDomains: effectiveBlockDomains,
              finalUrl: page.url(),
              title: await page.title().catch(() => ''),
              artifacts: {
                artifactDir: artifactDirRel,
                screenshots,
              },
              extracted,
            });
          } catch (error: any) {
            await session.close();
            return toJsonResult({
              ok: false,
              error: error?.message ?? String(error),
              cdpEndpoint: resolvedEndpoint,
              artifacts: {
                artifactDir: artifactDirRel,
              },
            });
          }
        },
      ),
    ],
  });
}
