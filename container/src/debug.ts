import fs from 'fs';
import path from 'path';
import { WORKSPACE_DIR } from './const.js';

/**
 * 将调试信息追加写入到特定的日志文件中
 * 适合用于记录非常长的数据（比如完整的对话上下文、大块的代码结果等）
 *
 * @param tag 日志标签，用于说明这条日志是关于什么的（比如 'AI_RESPONSE'）
 * @param data 需要记录的数据，可以是对象也可以是字符串
 */
export function logger(tag: string, data: any): void {
  // 1. 确定日志文件的路径：/workspace/files/temp/container-debug.log
  const tempDir = path.join(WORKSPACE_DIR, '/temp');
  const logPath = path.join(tempDir, 'container-debug.log');

  // 2. 确保 temp 目录存在，如果不存在则自动创建
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // 3. 拼接当前时间、标签，以及把数据转成字符串
  const time = new Date().toISOString();
  const content = `[${time}] [${tag}]\n${JSON.stringify(data, null, 2)}\n\n`;

  // 4. 将内容追加（append）到文件中。如果文件不存在会自动创建
  fs.appendFileSync(logPath, content, 'utf-8');
}
