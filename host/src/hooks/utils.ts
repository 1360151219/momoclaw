import { existsSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';

/**
 * 安全的 JSON 序列化，处理循环引用
 */
export function safeStringify(obj: unknown): string {
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
 * 查找项目根目录
 * 从当前目录向上遍历，直到找到包含 .git 的目录
 */
export function findProjectRoot(startPath: string): string {
  let currentDir = startPath;
  while (true) {
    if (existsSync(join(currentDir, '.git'))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error('无法找到项目根目录（未发现 .git）');
    }
    currentDir = parentDir;
  }
}

/**
 * 确保目录存在并赋予指定权限
 */
export function ensureDirWithPerms(
  dirPath: string,
  mode: number = 0o777,
): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  chmodSync(dirPath, mode);
}
