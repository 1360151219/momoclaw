/**
 * Feishu-specific chat-to-session mapping storage
 * Keeps Session layer pure by managing channel-specific mappings separately
 */

import { getDb } from '../connection.js';

/**
 * Initialize the feishu_mappings table
 */
export function initFeishuMappingsTable(db: any): void {
  db.exec(`
        CREATE TABLE IF NOT EXISTS feishu_mappings (
            chat_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_feishu_session ON feishu_mappings(session_id)`,
  );
}

export interface FeishuMapping {
  chatId: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Get session ID for a chat (from DB)
 */
export function getMapping(chatId: string): FeishuMapping | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM feishu_mappings WHERE chat_id = ?')
    .get(chatId) as any;

  if (!row) return undefined;

  return {
    chatId: row.chat_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Set or update mapping
 */
export function setMapping(chatId: string, sessionId: string): FeishuMapping {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `
        INSERT INTO feishu_mappings (chat_id, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
            session_id = excluded.session_id,
            updated_at = excluded.updated_at
    `,
  ).run(chatId, sessionId, now, now);

  return {
    chatId,
    sessionId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Delete mapping for a chat
 */
export function deleteMapping(chatId: string): boolean {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM feishu_mappings WHERE chat_id = ?')
    .run(chatId);
  return result.changes > 0;
}

/**
 * Get all mappings (useful for cache warmup)
 */
export function listMappings(): FeishuMapping[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM feishu_mappings ORDER BY updated_at DESC')
    .all() as any[];

  return rows.map((row) => ({
    chatId: row.chat_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Get chat ID by session ID (reverse lookup)
 */
export function getChatBySession(sessionId: string): FeishuMapping | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM feishu_mappings WHERE session_id = ?')
    .get(sessionId) as any;

  if (!row) return undefined;

  return {
    chatId: row.chat_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
