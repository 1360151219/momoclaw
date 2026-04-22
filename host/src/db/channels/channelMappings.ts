/**
 * 通用渠道映射模块
 *
 * 管理「渠道聊天 ID」到「会话 ID」的映射关系。
 * 用一张统一的 channel_mappings 表替代各渠道的独立映射表（如 feishu_mappings），
 * 通过 channel_type 字段区分不同渠道，逻辑完全复用。
 *
 * 支持的渠道：feishu、weixin（未来可扩展更多）
 */

import { getDb } from '../connection.js';

/**
 * 初始化 channel_mappings 表
 * 使用 (channel_type, chat_id) 作为联合主键，保证同一渠道的同一聊天只有一条映射
 */
export function initChannelMappingsTable(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_mappings (
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (channel_type, chat_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_channel_mappings_session ON channel_mappings(session_id)`,
  );
}

export interface ChannelMapping {
  channelType: string;
  chatId: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 查询指定渠道 + 聊天 ID 对应的 session 映射
 */
export function getChannelMapping(
  channelType: string,
  chatId: string,
): ChannelMapping | undefined {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT * FROM channel_mappings WHERE channel_type = ? AND chat_id = ?',
    )
    .get(channelType, chatId) as any;

  if (!row) return undefined;

  return {
    channelType: row.channel_type,
    chatId: row.chat_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 设置或更新映射（upsert）
 * 同一个 (channel_type, chat_id) 只保留一条记录，始终指向最新的 session
 */
export function setChannelMapping(
  channelType: string,
  chatId: string,
  sessionId: string,
): ChannelMapping {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `
    INSERT INTO channel_mappings (channel_type, chat_id, session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(channel_type, chat_id) DO UPDATE SET
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
    `,
  ).run(channelType, chatId, sessionId, now, now);

  return {
    channelType,
    chatId,
    sessionId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 删除指定渠道 + 聊天 ID 的映射
 */
export function deleteChannelMapping(
  channelType: string,
  chatId: string,
): boolean {
  const db = getDb();
  const result = db
    .prepare(
      'DELETE FROM channel_mappings WHERE channel_type = ? AND chat_id = ?',
    )
    .run(channelType, chatId);
  return result.changes > 0;
}

/**
 * 列出某个渠道下的所有映射（按更新时间倒序）
 */
export function listChannelMappings(channelType: string): ChannelMapping[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM channel_mappings WHERE channel_type = ? ORDER BY updated_at DESC',
    )
    .all(channelType) as any[];

  return rows.map((row) => ({
    channelType: row.channel_type,
    chatId: row.chat_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * 通过 sessionId 反查映射（用于查找某个 session 属于哪个渠道的哪个聊天）
 */
export function getChannelByChatSession(
  sessionId: string,
): ChannelMapping | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM channel_mappings WHERE session_id = ?')
    .get(sessionId) as any;

  if (!row) return undefined;

  return {
    channelType: row.channel_type,
    chatId: row.chat_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
