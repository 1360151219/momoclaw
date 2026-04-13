/**
 * Browser MCP tools (skill-first)
 *
 * This module exposes a small set of MCP tools for browser automation.
 * The "skill" owns the flow/rules; these tools are the execution layer.
 *
 * Design choice:
 * - We connect to an existing Chrome/Chromium via CDP (DevTools Protocol).
 * - This avoids bundling browsers + GUI deps into the agent container image.
 * - Works well with "later visualization": you can run a headed Chrome on host,
 *   and the agent will drive it remotely.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { chromium, type Browser, type Page } from 'playwright-core';

const WORKSPACE_DIR = '/workspace/files';
const DEFAULT_CDP_ENDPOINT =
  process.env.BROWSER_CDP_ENDPOINT || 'http://host.docker.internal:9222';

/**
 * 伪装成真实 Chrome 的 User-Agent（Windows 10 + Chrome 131）。
 * 网站会检查 UA 里是否包含 "HeadlessChrome"，所以这里必须用正常值。
 */
const REALISTIC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 反检测用的 context 参数。
 * 这些值要和 UA 保持一致（Windows + zh-CN + 东八区），否则不一致本身就是一个检测信号。
 */
const STEALTH_CONTEXT_OPTIONS = {
  userAgent: REALISTIC_USER_AGENT,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  colorScheme: 'light' as const,
  extraHTTPHeaders: {
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
};
const GLOBAL_BLOCKLIST_PATH = path.join(
  WORKSPACE_DIR,
  'credentials',
  'browser',
  'blocklist.json',
);
const CHROMIUM_STATE_PATH = path.join(
  WORKSPACE_DIR,
  'temp',
  'browser',
  'chromium-state.json',
);

// Built-in safety blocklist (always enforced).
// This is here to prevent obvious SSRF / internal network access even when
// user blocklist is empty.
const DEFAULT_BLOCKED_HOST_PATTERNS: string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  // Cloud metadata endpoints
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.google.internal.',
  'metadata.tencentyun.com',
  // Common internal domain patterns
  '*.local',
  '*.internal',
  '*.lan',
  '*.docker',
  '*.svc',
  '*.cluster.local',
];

/**
 * Ensure a directory exists (mkdir -p).
 */
function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Best-effort check whether a PID is alive AND not a zombie.
 * Zombie processes remain in the process table but are not actually running.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // Check if process is a zombie (state 'Z' in /proc/[pid]/stat)
    try {
      const statContent = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // The state is the 3rd field in /proc/[pid]/stat, enclosed in parentheses
      // Format: pid (comm) state ppid ...
      const match = statContent.match(/^\d+\s+\([^)]+\)\s+(\w)/);
      if (match && match[1] === 'Z') {
        return false; // Zombie process
      }
    } catch {
      // If we can't read /proc/[pid]/stat, assume process is not alive
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up zombie chromium processes.
 * In containers, zombie processes can accumulate when chromium exits but
 * the parent process doesn't reap them properly.
 */
function cleanupZombieProcesses(): void {
  try {
    // Find all zombie chromium processes and kill their parent to reap them
    const procDir = '/proc';
    const entries = fs.readdirSync(procDir);

    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;

      try {
        const pid = parseInt(entry, 10);
        const statPath = `${procDir}/${entry}/stat`;
        const statContent = fs.readFileSync(statPath, 'utf-8');

        // Check if it's a zombie (state 'Z')
        const match = statContent.match(/^\d+\s+\(([^)]+)\)\s+(\w)/);
        if (match && match[2] === 'Z' && match[1].toLowerCase().includes('chrome')) {
          // Get the parent PID
          const ppidMatch = statContent.match(/\) \w (\d+)/);
          if (ppidMatch) {
            const ppid = parseInt(ppidMatch[1], 10);
            try {
              // Kill parent to trigger zombie reaping
              process.kill(ppid, 'SIGTERM');
            } catch {
              // Ignore if can't kill
            }
          }
        }
      } catch {
        // Ignore errors for individual processes
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Read chromium state file.
 */
function readChromiumState():
  | {
      pid: number;
      port: number;
      cdpEndpoint: string;
      userDataDirRel: string;
      startedAt: number;
    }
  | undefined {
  try {
    if (!fs.existsSync(CHROMIUM_STATE_PATH)) return undefined;
    const raw = fs.readFileSync(CHROMIUM_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as any;
    if (
      typeof parsed?.pid !== 'number' ||
      typeof parsed?.port !== 'number' ||
      typeof parsed?.cdpEndpoint !== 'string' ||
      typeof parsed?.userDataDirRel !== 'string' ||
      typeof parsed?.startedAt !== 'number'
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Write chromium state file.
 */
function writeChromiumState(state: {
  pid: number;
  port: number;
  cdpEndpoint: string;
  userDataDirRel: string;
  startedAt: number;
}): void {
  ensureDir(path.dirname(CHROMIUM_STATE_PATH));
  fs.writeFileSync(
    CHROMIUM_STATE_PATH,
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}

/**
 * Delete chromium state file.
 */
function clearChromiumState(): void {
  try {
    if (fs.existsSync(CHROMIUM_STATE_PATH)) fs.unlinkSync(CHROMIUM_STATE_PATH);
  } catch {
    // ignore
  }
}

/**
 * Find a chromium executable within the container.
 *
 * IMPORTANT:
 * - This will only work if the container image actually contains Chromium.
 * - Current Dockerfile does not install it by default.
 */
function findChromiumExecutable(): string | undefined {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return undefined;
}

/**
 * Read global blocklist from workspace (if present).
 *
 * File format:
 * {
 *   "domains": ["example.com", "*.example.com"]
 * }
 */
function readGlobalBlocklist(): string[] {
  try {
    if (!fs.existsSync(GLOBAL_BLOCKLIST_PATH)) return [];
    const raw = fs.readFileSync(GLOBAL_BLOCKLIST_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { domains?: unknown };
    if (!Array.isArray(parsed.domains)) return [];
    return parsed.domains.filter((d): d is string => typeof d === 'string');
  } catch {
    return [];
  }
}

/**
 * Persist global blocklist to workspace.
 */
function writeGlobalBlocklist(domains: string[]): void {
  const dir = path.dirname(GLOBAL_BLOCKLIST_PATH);
  ensureDir(dir);
  fs.writeFileSync(
    GLOBAL_BLOCKLIST_PATH,
    JSON.stringify({ domains }, null, 2),
    'utf-8',
  );
}

/**
 * Check if hostname is an IPv4 literal.
 */
function isIpv4Literal(hostname: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

/**
 * Check if an IPv4 literal is private / local / link-local / reserved.
 */
function isBlockedIpv4(ipv4: string): boolean {
  const parts = ipv4.split('.').map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true; // treat invalid as blocked
  }
  // 127.0.0.0/8 loopback
  if (parts[0] === 127) return true;
  // 10.0.0.0/8 private
  if (parts[0] === 10) return true;
  // 172.16.0.0/12 private
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16 private
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 169.254.0.0/16 link-local
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0/8 reserved
  if (parts[0] === 0) return true;
  return false;
}

/**
 * Match a hostname against blocklist patterns.
 *
 * Supported patterns:
 * - "example.com" blocks example.com AND any subdomain (*.example.com)
 * - "*.example.com" blocks any subdomain (and also blocks example.com)
 */
function isHostBlockedByPatterns(
  hostname: string,
  blockDomains: string[],
): boolean {
  const host = hostname.toLowerCase();
  for (const ruleRaw of blockDomains) {
    const rule = ruleRaw.toLowerCase().trim();
    if (!rule) continue;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      if (host === suffix) return true;
      if (host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    // For user convenience: blocking "example.com" also blocks subdomains.
    if (host === rule) return true;
    if (host.endsWith(`.${rule}`)) return true;
  }
  return false;
}

/**
 * Validate a URL is http(s) and NOT blocked by the effective blocklist.
 * Throws a friendly error message on violation.
 */
function assertUrlNotBlocked(urlStr: string, blockDomains: string[]): void {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are allowed. Got: ${u.protocol}`);
  }

  const host = u.hostname.toLowerCase();
  if (isIpv4Literal(host) && isBlockedIpv4(host)) {
    throw new Error(`Navigation blocked. IPv4 host "${host}" is not allowed.`);
  }

  // Always apply built-in safety patterns + user-defined blocklist.
  const effective = [...DEFAULT_BLOCKED_HOST_PATTERNS, ...blockDomains];
  if (isHostBlockedByPatterns(host, effective)) {
    throw new Error(
      `Navigation blocked by blocklist. Host "${host}" is blocked.`,
    );
  }
}

/**
 * After each navigation-like step, re-check the current page URL against blocklist.
 * This prevents unexpected cross-domain redirects.
 */
async function assertCurrentPageNotBlocked(
  page: Page,
  blockDomains: string[],
): Promise<void> {
  const currentUrl = page.url();
  assertUrlNotBlocked(currentUrl, blockDomains);
}

const StepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('goto'),
    url: z.string().describe('Destination URL (http/https).'),
    waitUntil: z
      .enum(['load', 'domcontentloaded', 'networkidle'])
      .optional()
      .describe('Navigation wait condition.'),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('click'),
    selector: z
      .string()
      .optional()
      .describe('CSS selector. Prefer stable selectors when possible.'),
    text: z
      .string()
      .optional()
      .describe('Click element by text content (fallback).'),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('fill'),
    selector: z.string().describe('CSS selector of input/textarea.'),
    value: z.string().describe('Text to fill.'),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('press'),
    key: z.string().describe('Keyboard key, e.g. Enter, Escape, Tab.'),
  }),
  z.object({
    type: z.literal('waitFor'),
    selector: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('scroll'),
    deltaY: z.number().int().describe('Vertical scroll delta.'),
  }),
  z.object({
    type: z.literal('extract'),
    kind: z.enum(['text', 'links', 'table']),
    selector: z
      .string()
      .optional()
      .describe('Optional scope selector. Defaults to whole page.'),
  }),
  z.object({
    type: z.literal('screenshot'),
    fullPage: z.boolean().optional(),
    path: z
      .string()
      .optional()
      .describe(
        'Relative path under /workspace/files. If omitted, auto-generated.',
      ),
  }),
]);

type Step = z.infer<typeof StepSchema>;

/**
 * Connect to a remote Chrome/Chromium via CDP.
 *
 * Typical endpoint:
 * - http://host.docker.internal:9222
 * - http://<browser-container>:9222
 */
async function connectBrowser(cdpEndpoint: string): Promise<Browser> {
  // connectOverCDP does not require bundled browser binaries (playwright-core is enough).
  return chromium.connectOverCDP(cdpEndpoint);
}

/**
 * Apply "low-memory" defaults to a context:
 * - Block heavy resource types (images/fonts/media) to save memory/bandwidth.
 *
 * Notes:
 * - This improves stability on 2GB RAM servers, but may break some image-based sites.
 * - The skill can always retry with a different strategy if needed.
 */
async function applyLowMemoryRouting(page: Page): Promise<void> {
  await page.route('**/*', async (route: any) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'font' || type === 'media') {
      await route.abort();
      return;
    }
    await route.continue();
  });
}

/**
 * Execute a small, restricted step DSL on a single page.
 *
 * Note: this intentionally does NOT support arbitrary JS execution.
 */
async function runSteps(params: {
  page: Page;
  steps: Step[];
  blockDomains: string[];
  artifactDirRel: string;
}): Promise<{
  screenshots: string[];
  extracted: Array<{ kind: string; data: unknown }>;
}> {
  const { page, steps, blockDomains, artifactDirRel } = params;
  const screenshots: string[] = [];
  const extracted: Array<{ kind: string; data: unknown }> = [];

  for (const step of steps) {
    switch (step.type) {
      case 'goto': {
        assertUrlNotBlocked(step.url, blockDomains);
        await page.goto(step.url, {
          waitUntil: step.waitUntil ?? 'domcontentloaded',
          timeout: step.timeoutMs ?? 60_000,
        });
        await assertCurrentPageNotBlocked(page, blockDomains);
        break;
      }
      case 'click': {
        const timeout = step.timeoutMs ?? 30_000;
        if (step.selector) {
          await page.locator(step.selector).first().click({ timeout });
        } else if (step.text) {
          // Simple text-based fallback; good enough for v1.
          await page.getByText(step.text, { exact: false }).first().click({
            timeout,
          });
        } else {
          throw new Error('click step requires selector or text');
        }
        await assertCurrentPageNotBlocked(page, blockDomains);
        break;
      }
      case 'fill': {
        const timeout = step.timeoutMs ?? 30_000;
        await page.locator(step.selector).first().fill(step.value, { timeout });
        break;
      }
      case 'press': {
        await page.keyboard.press(step.key);
        await assertCurrentPageNotBlocked(page, blockDomains);
        break;
      }
      case 'waitFor': {
        const timeout = step.timeoutMs ?? 30_000;
        if (step.selector) {
          await page.waitForSelector(step.selector, { timeout });
        } else {
          await page.waitForTimeout(timeout);
        }
        await assertCurrentPageNotBlocked(page, blockDomains);
        break;
      }
      case 'scroll': {
        await page.mouse.wheel(0, step.deltaY);
        break;
      }
      case 'extract': {
        if (step.kind === 'text') {
          const locator = step.selector
            ? page.locator(step.selector).first()
            : page.locator('body');
          const text = await locator.innerText({ timeout: 30_000 });
          extracted.push({ kind: 'text', data: text });
        } else if (step.kind === 'links') {
          const scope = step.selector ? `${step.selector} a` : 'a';
          const links = await page.$$eval(scope, (as: any[]) =>
            as
              .map((a: any) => ({
                text: (a.textContent || '').trim(),
                href: (a.href as string) || '',
              }))
              .filter((x: any) => x.href),
          );
          extracted.push({ kind: 'links', data: links });
        } else if (step.kind === 'table') {
          const tableSel = step.selector ?? 'table';
          const rows = await page.$$eval(`${tableSel} tr`, (trs: any[]) =>
            trs.map((tr: any) =>
              Array.from(tr.querySelectorAll('th,td')).map((td: any) =>
                (td.textContent || '').trim(),
              ),
            ),
          );
          extracted.push({ kind: 'table', data: rows });
        }
        break;
      }
      case 'screenshot': {
        const rel =
          step.path?.replace(/^\//, '') ??
          path.join(artifactDirRel, `${Date.now()}.png`);
        const abs = path.join(WORKSPACE_DIR, rel);
        ensureDir(path.dirname(abs));
        await page.screenshot({ path: abs, fullPage: step.fullPage ?? true });
        screenshots.push(rel);
        break;
      }
      default: {
        throw new Error(`Unsupported step: ${(step as any).type}`);
      }
    }
  }

  return { screenshots, extracted };
}

/**
 * Create browser MCP server.
 *
 * Tools:
 * - browser_get_blocklist: read global blocklist
 * - browser_set_blocklist: write global blocklist
 * - browser_run: connect to remote browser via CDP and execute a restricted step DSL
 */
export function createBrowserMcpServer() {
  return createSdkMcpServer({
    name: 'momoclaw-browser-mcp',
    version: '1.0.0',
    tools: [
      tool(
        'browser_chromium_status',
        '查询当前容器内 headless Chromium 的运行状态（如果曾通过 browser_start_chromium 启动）。',
        {},
        async () => {
          // Clean up any zombie processes before checking status
          cleanupZombieProcesses();

          const state = readChromiumState();
          if (!state) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ running: false }, null, 2),
                },
              ],
            };
          }
          const alive = isPidAlive(state.pid);
          // If process is not alive (or is a zombie), clear the stale state
          if (!alive) {
            clearChromiumState();
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    running: alive,
                    ...state,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        },
      ),
      tool(
        'browser_start_chromium',
        [
          '在容器内启动一个 headless Chromium，并开启 CDP 端口供 browser_run 连接。',
          '注意：这需要容器镜像里已经安装 chromium/chromium-browser。',
          '如果未安装，本工具会返回明确错误信息和建议。',
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
            .describe('如果已有 Chromium 在跑，是否直接复用（默认 true）。'),
        },
        async ({ port, keepExisting }) => {
          const reuse = keepExisting ?? true;

          // Clean up any zombie processes before checking/starting chromium
          cleanupZombieProcesses();

          const existing = readChromiumState();
          if (existing) {
            if (isPidAlive(existing.pid)) {
              if (reuse) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify(
                        { ok: true, reused: true, ...existing },
                        null,
                        2,
                      ),
                    },
                  ],
                };
              }
            } else {
              // Process is dead or zombie, clear stale state
              clearChromiumState();
            }
          }

          const exe = findChromiumExecutable();
          if (!exe) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      ok: false,
                      error:
                        'Chromium executable not found in container. Install chromium in the image or set CHROMIUM_PATH.',
                      hint: 'Ensure the container image includes chromium (e.g. `apk add chromium nss ca-certificates freetype harfbuzz ttf-freefont`), or set CHROMIUM_PATH to the executable path.',
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          const debugPort = port ?? 9222;
          const userDataDirRel = path.join(
            'temp',
            'browser',
            'chromium-profile',
          );
          const userDataDirAbs = path.join(WORKSPACE_DIR, userDataDirRel);
          ensureDir(userDataDirAbs);

          // 启动参数分三类：基础隔离、省内存、反检测。
          const args = [
            // --- 基础隔离 ---
            '--headless=new',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            `--remote-debugging-address=0.0.0.0`,
            `--remote-debugging-port=${debugPort}`,
            `--user-data-dir=${userDataDirAbs}`,

            // --- 省内存 ---
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-extensions',
            '--disable-sync',
            '--metrics-recording-only',
            '--mute-audio',

            // --- 反检测 ---
            // 用真实 UA 覆盖默认的 HeadlessChrome UA
            `--user-agent=${REALISTIC_USER_AGENT}`,
            // 设置语言，和 context 里的 locale/Accept-Language 保持一致
            '--lang=zh-CN',
            // 禁用 Blink 的自动化标记（navigator.webdriver / infobar 等）
            '--disable-blink-features=AutomationControlled',
            // 窗口大小和 context viewport 一致
            '--window-size=1920,1080',
          ];

          const child = spawn(exe, args, {
            stdio: ['ignore', 'ignore', 'ignore'],
            detached: true,
          });
          child.unref();

          const state = {
            pid: child.pid ?? -1,
            port: debugPort,
            cdpEndpoint: `http://127.0.0.1:${debugPort}`,
            userDataDirRel,
            startedAt: Date.now(),
          };

          if (state.pid > 0) {
            // Give Chromium a moment to initialize; if it exits immediately,
            // it's usually due to flag incompatibility or port conflicts.
            await new Promise((r) => setTimeout(r, 300));
            if (!isPidAlive(state.pid)) {
              clearChromiumState();
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(
                      {
                        ok: false,
                        error: 'Chromium exited immediately after spawn.',
                        hint: 'Common causes: remote-debugging port is already in use, or Chromium does not support `--headless=new` on this version. Try a different port, or adjust flags.',
                      },
                      null,
                      2,
                    ),
                  },
                ],
              };
            }

            writeChromiumState(state);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ ok: true, ...state }, null, 2),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { ok: false, error: 'Failed to spawn Chromium process.' },
                  null,
                  2,
                ),
              },
            ],
          };
        },
      ),
      tool(
        'browser_stop_chromium',
        '停止由 browser_start_chromium 启动的 Chromium（如果存在）。',
        {
          force: z
            .boolean()
            .optional()
            .describe('是否强制 kill（默认 true）。'),
        },
        async ({ force }) => {
          // Clean up any zombie processes before stopping
          cleanupZombieProcesses();

          const state = readChromiumState();
          if (!state) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ ok: true, stopped: false }, null, 2),
                },
              ],
            };
          }
          const sig: NodeJS.Signals = force === false ? 'SIGTERM' : 'SIGKILL';
          try {
            if (isPidAlive(state.pid)) {
              process.kill(state.pid, sig);
            }
          } catch {
            // ignore
          } finally {
            clearChromiumState();
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ ok: true, stopped: true }, null, 2),
              },
            ],
          };
        },
      ),
      tool(
        'browser_get_blocklist',
        '读取全局 blocklist（存放在 workspace/credentials/browser/blocklist.json）。',
        {},
        async () => {
          const domains = readGlobalBlocklist();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ domains }, null, 2),
              },
            ],
          };
        },
      ),
      tool(
        'browser_set_blocklist',
        '写入全局 blocklist。支持 "example.com" 或 "*.example.com"。注意：屏蔽 "example.com" 会同时屏蔽其子域名。',
        {
          domains: z.array(z.string()).describe('要屏蔽的域名列表。'),
        },
        async ({ domains }) => {
          writeGlobalBlocklist(domains);
          return {
            content: [{ type: 'text' as const, text: 'OK' }],
          };
        },
      ),
      tool(
        'browser_run',
        [
          '通过 CDP 连接一个已存在的 Chrome/Chromium，然后执行受限步骤 DSL。',
          `默认 CDP 地址为 ${DEFAULT_CDP_ENDPOINT}（可用 cdpEndpoint 覆盖，或设置环境变量 BROWSER_CDP_ENDPOINT）。`,
          '注意：默认允许访问所有站点，但会强制屏蔽 localhost/内网/云元数据等目标；你也可以配置全局 blocklist 进一步屏蔽域名。',
          '默认开启低内存模式：会屏蔽图片/字体/视频等资源类型，以提升 2GB 内存服务器稳定性。',
        ].join('\n'),
        {
          cdpEndpoint: z
            .string()
            .optional()
            .describe('CDP endpoint，例如 http://host.docker.internal:9222'),
          steps: z.array(StepSchema).describe('要执行的步骤列表（受限 DSL）。'),
          blockDomains: z
            .array(z.string())
            .optional()
            .describe('可选：本次覆盖 blocklist。不传则使用全局 blocklist。'),
        },
        async ({ cdpEndpoint, steps, blockDomains }) => {
          // Priority:
          // 1) explicit cdpEndpoint
          // 2) container-managed Chromium (started by browser_start_chromium)
          // 3) env/default endpoint
          const local = readChromiumState();
          const localEndpoint =
            local && isPidAlive(local.pid) ? local.cdpEndpoint : undefined;
          const endpoint = cdpEndpoint ?? localEndpoint ?? DEFAULT_CDP_ENDPOINT;
          const domains = blockDomains?.length
            ? blockDomains
            : readGlobalBlocklist();

          // Create artifact directory (per tool invocation).
          const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const artifactDirRel = path.join('temp', 'browser', runId);
          const artifactDirAbs = path.join(WORKSPACE_DIR, artifactDirRel);
          ensureDir(artifactDirAbs);

          let browser: Browser | undefined;
          try {
            browser = await connectBrowser(endpoint);

            // Always create an isolated context per run to avoid memory buildup.
            // 使用反检测参数，模拟真实浏览器环境，避免触发验证码。
            const context = await browser.newContext(STEALTH_CONTEXT_OPTIONS);

            // 在每个新页面加载前注入反检测脚本：
            // 1. navigator.webdriver = false（Playwright 默认为 true，是最常见的检测点）
            // 2. 伪造 plugins/languages 等使环境看起来更像真实浏览器
            await context.addInitScript(() => {
              Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
              });
              Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
              });
              Object.defineProperty(navigator, 'languages', {
                get: () => ['zh-CN', 'zh', 'en'],
              });
              (window as any).chrome = { runtime: {} };
            });

            const page = await context.newPage();
            await applyLowMemoryRouting(page);

            const { screenshots, extracted } = await runSteps({
              page,
              steps,
              blockDomains: domains,
              artifactDirRel,
            });

            // Always take a final screenshot for traceability (unless already taken).
            if (screenshots.length === 0) {
              const rel = path.join(artifactDirRel, 'final.png');
              const abs = path.join(WORKSPACE_DIR, rel);
              await page.screenshot({ path: abs, fullPage: true });
              screenshots.push(rel);
            }

            const result = {
              ok: true,
              cdpEndpoint: endpoint,
              blockDomains: domains,
              finalUrl: page.url(),
              artifacts: {
                screenshots,
                artifactDir: artifactDirRel,
              },
              extracted,
            };

            await page.close().catch(() => {});
            await context.close().catch(() => {});

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (err: any) {
            const result = {
              ok: false,
              error: err?.message || String(err),
              cdpEndpoint: endpoint,
              blockDomains: domains,
              artifacts: { artifactDir: artifactDirRel },
            };
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } finally {
            try {
              // Close connection (does not necessarily close the remote browser).
              await browser?.close();
            } catch {
              // ignore
            }
          }
        },
      ),
    ],
  });
}
