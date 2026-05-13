import { getDb } from './connection.js';
import type { BotTokenInfo } from '../weixin/types.js';

export interface WeixinUserRow {
  id: string;
  name: string;
  bot_token: string | null;
  ilink_bot_id: string | null;
  ilink_user_id: string | null;
  baseurl: string | null;
  status: 'pending' | 'active' | 'error' | 'stopped';
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export function initWeixinUsersTable(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weixin_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bot_token TEXT,
      ilink_bot_id TEXT,
      ilink_user_id TEXT,
      baseurl TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'active', 'error', 'stopped')),
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function rowToUser(row: any): WeixinUserRow {
  return {
    id: row.id,
    name: row.name,
    bot_token: row.bot_token,
    ilink_bot_id: row.ilink_bot_id,
    ilink_user_id: row.ilink_user_id,
    baseurl: row.baseurl,
    status: row.status,
    error_message: row.error_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerWeixinUser(
  id: string,
  name: string,
  tokenInfo?: BotTokenInfo,
): WeixinUserRow {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO weixin_users (id, name, bot_token, ilink_bot_id, ilink_user_id, baseurl, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    name,
    tokenInfo?.bot_token ?? null,
    tokenInfo?.ilink_bot_id ?? null,
    tokenInfo?.ilink_user_id ?? null,
    tokenInfo?.baseurl ?? null,
    now,
    now,
  );

  return {
    id,
    name,
    bot_token: tokenInfo?.bot_token ?? null,
    ilink_bot_id: tokenInfo?.ilink_bot_id ?? null,
    ilink_user_id: tokenInfo?.ilink_user_id ?? null,
    baseurl: tokenInfo?.baseurl ?? null,
    status: 'pending',
    error_message: null,
    created_at: now,
    updated_at: now,
  };
}

export function getWeixinUser(id: string): WeixinUserRow | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM weixin_users WHERE id = ?')
    .get(id) as any;
  return row ? rowToUser(row) : undefined;
}

export function listWeixinUsers(): WeixinUserRow[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM weixin_users ORDER BY created_at DESC')
    .all() as any[];
  return rows.map(rowToUser);
}

export function updateWeixinUserStatus(
  id: string,
  status: WeixinUserRow['status'],
  errorMessage?: string,
): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE weixin_users SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`,
    )
    .run(status, errorMessage || null, Date.now(), id);
  return result.changes > 0;
}

export function updateWeixinUserToken(
  id: string,
  tokenInfo: BotTokenInfo,
): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE weixin_users
       SET bot_token = ?, ilink_bot_id = ?, ilink_user_id = ?, baseurl = ?,
           status = 'active', error_message = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      tokenInfo.bot_token ?? null,
      tokenInfo.ilink_bot_id ?? null,
      tokenInfo.ilink_user_id ?? null,
      tokenInfo.baseurl ?? null,
      Date.now(),
      id,
    );
  return result.changes > 0;
}

export function deleteWeixinUser(id: string): boolean {
  const db = getDb();
  // Clean up associated mappings
  db.prepare('DELETE FROM weixin_mappings WHERE wx_user_id = ?').run(id);
  const result = db.prepare('DELETE FROM weixin_users WHERE id = ?').run(id);
  return result.changes > 0;
}
