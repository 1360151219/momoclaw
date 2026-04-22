import fs from 'fs';
import path from 'path';
import { CHROMIUM_STATE_PATH, type ChromiumState } from './constants.js';

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * 检查进程是否存活且不是僵尸进程。
 *
 * 判定逻辑：
 * 1. 先用 process.kill(pid, 0) 检查进程是否存在（不发送信号，只检查权限）
 * 2. 如果 /proc/{pid}/stat 可读，额外排除僵尸进程（状态为 'Z'）
 * 3. 如果读不到 /proc（某些容器环境会出现），仍信任 kill(0) 的结果
 *
 * @param pid - 要检查的进程 ID
 * @returns 进程是否存活
 */
export function isPidAlive(pid: number): boolean {
  try {
    // kill(pid, 0) 不会实际发信号，只检查进程是否存在
    process.kill(pid, 0);

    // 进程存在，再尝试排除僵尸进程
    try {
      const statContent = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const match = statContent.match(/^\d+\s+\([^)]+\)\s+(\w)/);
      if (match && match[1] === 'Z') {
        return false; // 僵尸进程，视为已死
      }
    } catch {
      // 读不到 /proc/{pid}/stat（容器环境常见），
      // 不能因此判死——kill(0) 已经确认进程存在，信任它的结果
    }
    return true;
  } catch {
    // kill(0) 抛异常 = 进程不存在
    return false;
  }
}


/**
 * Read chromium state file.
 */
export function readChromiumState(): ChromiumState | undefined {
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
    return parsed as ChromiumState;
  } catch {
    return undefined;
  }
}

/**
 * Write chromium state file.
 */
export function writeChromiumState(state: ChromiumState): void {
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
export function clearChromiumState(): void {
  try {
    if (fs.existsSync(CHROMIUM_STATE_PATH)) fs.unlinkSync(CHROMIUM_STATE_PATH);
  } catch {
    // ignore
  }
}

/**
 * 等待指定 PID 退出。
 *
 * 这里采用轮询而不是依赖子进程句柄，因为很多 Chromium 进程并不是当前
 * Node 进程直接持有的 child 对象（例如来自历史 exec 或 detached 启动）。
 *
 * @param pid - 目标进程 ID
 * @param timeoutMs - 最长等待时间
 * @returns 进程是否已在超时内退出
 */
export async function waitForPidExit(
  pid: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return !isPidAlive(pid);
}

/**
 * 清理 Chromium profile 目录中的单例锁文件。
 *
 * 背景：
 * - Chromium 在 profile 目录里会写入 `Singleton*` 文件，防止多个进程同时使用同一 profile
 * - 如果浏览器异常退出、容器被强杀，锁文件可能残留
 * - 下次重新启动时就会报 “The profile appears to be in use by another Chromium process”
 *
 * 注意：
 * - 这里只删除 Chromium 已知的单例锁文件，不会删除整个 profile
 * - 调用方必须先确保当前没有存活的 Chromium 仍在使用该 profile
 *
 * @param userDataDirAbs - Chromium profile 绝对路径
 */
export function clearChromiumProfileLocks(userDataDirAbs: string): void {
  const singletonEntries = [
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
  ];

  for (const entry of singletonEntries) {
    const targetPath = path.join(userDataDirAbs, entry);
    try {
      // lstatSync 只检查链接本身是否存在，能正确检测到 dangling symlink。
      fs.lstatSync(targetPath);
      fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (err: any) {
      // ENOENT = 文件确实不存在，可以安全忽略
      if (err?.code !== 'ENOENT') {
        console.warn(`[browser-mcp] Failed to remove ${entry}:`, err?.message);
      }
    }
  }
}

/**
 * Find a chromium executable within the container.
 */
export function findChromiumExecutable(): string | undefined {
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
