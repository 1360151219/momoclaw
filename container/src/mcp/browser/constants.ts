import path from 'path';

export const WORKSPACE_DIR = '/workspace/files';
export const DEFAULT_CDP_ENDPOINT =
  process.env.BROWSER_CDP_ENDPOINT || 'http://host.docker.internal:9222';

/**
 * 伪装成真实 Chrome 的 User-Agent（Windows 10 + Chrome 131）。
 */
export const REALISTIC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 这些值要和 UA 保持一致（Windows + zh-CN + 东八区），否则不一致本身就是一个检测信号。
 */
export const STEALTH_CONTEXT_OPTIONS = {
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

export const GLOBAL_BLOCKLIST_PATH = path.join(
  WORKSPACE_DIR,
  'credentials',
  'browser',
  'blocklist.json',
);

export const CHROMIUM_STATE_PATH = path.join(
  WORKSPACE_DIR,
  'temp',
  'browser',
  'chromium-state.json',
);

// Built-in safety blocklist (always enforced).
export const DEFAULT_BLOCKED_HOST_PATTERNS: string[] = [
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

export interface ChromiumState {
  pid: number;
  port: number;
  cdpEndpoint: string;
  userDataDirRel: string;
  startedAt: number;
}
