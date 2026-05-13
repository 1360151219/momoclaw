import { getDb } from './connection.js';

export interface WeixinMapping {
  id: number;
  wxUserId: string;
  fromUserId: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

export function initWeixinMappingsTable(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weixin_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wx_user_id TEXT NOT NULL,
      from_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(wx_user_id, from_user_id),
      FOREIGN KEY (wx_user_id) REFERENCES weixin_users(id) ON DELETE CASCADE
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_wx_mappings_session ON weixin_mappings(session_id)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_wx_mappings_wx_user ON weixin_mappings(wx_user_id)`,
  );
}

function rowToMapping(row: any): WeixinMapping {
  return {
    id: row.id,
    wxUserId: row.wx_user_id,
    fromUserId: row.from_user_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getMapping(
  wxUserId: string,
  fromUserId: string,
): WeixinMapping | undefined {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT * FROM weixin_mappings WHERE wx_user_id = ? AND from_user_id = ?',
    )
    .get(wxUserId, fromUserId) as any;
  return row ? rowToMapping(row) : undefined;
}

export function setMapping(
  wxUserId: string,
  fromUserId: string,
  sessionId: string,
): WeixinMapping {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO weixin_mappings (wx_user_id, from_user_id, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(wx_user_id, from_user_id) DO UPDATE SET
       session_id = excluded.session_id,
       updated_at = excluded.updated_at`,
  ).run(wxUserId, fromUserId, sessionId, now, now);

  return {
    id: 0, // auto-increment, not critical for return value on upsert
    wxUserId,
    fromUserId,
    sessionId,
    createdAt: now,
    updatedAt: now,
  };
}

export function deleteMapping(
  wxUserId: string,
  fromUserId: string,
): boolean {
  const db = getDb();
  const result = db
    .prepare(
      'DELETE FROM weixin_mappings WHERE wx_user_id = ? AND from_user_id = ?',
    )
    .run(wxUserId, fromUserId);
  return result.changes > 0;
}

export function listMappingsByWxUser(wxUserId: string): WeixinMapping[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM weixin_mappings WHERE wx_user_id = ? ORDER BY updated_at DESC',
    )
    .all(wxUserId) as any[];
  return rows.map(rowToMapping);
}

export function getSessionByMapping(
  wxUserId: string,
  fromUserId: string,
): string | undefined {
  const mapping = getMapping(wxUserId, fromUserId);
  return mapping?.sessionId;
}
