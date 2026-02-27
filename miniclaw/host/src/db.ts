import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { Message, Session } from './types.js';

let db: Database.Database | null = null;

export function initDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // 创建sessions表
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0
    )
  `);

  // 创建messages表
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      tool_calls TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // 创建索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)`);

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

// Session operations
export function createSession(
  id: string,
  name: string,
  systemPrompt: string = '',
  model?: string
): Session {
  const db = getDb();
  const now = Date.now();

  // 先取消其他会话的active状态
  db.prepare('UPDATE sessions SET is_active = 0 WHERE is_active = 1').run();

  const stmt = db.prepare(`
    INSERT INTO sessions (id, name, system_prompt, model, created_at, updated_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);

  stmt.run(id, name, systemPrompt, model || null, now, now);

  return {
    id,
    name,
    systemPrompt,
    model: model || '',
    createdAt: now,
    updatedAt: now,
    isActive: true,
  };
}

export function getSession(id: string): Session | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;

  if (!row) return undefined;

  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    model: row.model || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isActive: row.is_active === 1,
  };
}

export function getActiveSession(): Session | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE is_active = 1').get() as any;

  if (!row) return undefined;

  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    model: row.model || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isActive: true,
  };
}

export function listSessions(): Session[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as any[];

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    model: row.model || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isActive: row.is_active === 1,
  }));
}

export function switchSession(id: string): boolean {
  const db = getDb();

  // 检查会话是否存在
  const session = getSession(id);
  if (!session) return false;

  // 取消所有active状态
  db.prepare('UPDATE sessions SET is_active = 0').run();

  // 设置目标会话为active
  const result = db.prepare('UPDATE sessions SET is_active = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);

  return result.changes > 0;
}

export function deleteSession(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateSessionPrompt(id: string, systemPrompt: string): boolean {
  const db = getDb();
  const result = db.prepare('UPDATE sessions SET system_prompt = ?, updated_at = ? WHERE id = ?')
    .run(systemPrompt, Date.now(), id);
  return result.changes > 0;
}

export function updateSessionModel(id: string, model: string): boolean {
  const db = getDb();
  const result = db.prepare('UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?')
    .run(model, Date.now(), id);
  return result.changes > 0;
}

// Message operations
export function addMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  toolCalls?: unknown[]
): Message {
  const db = getDb();
  const timestamp = Date.now();

  const stmt = db.prepare(`
    INSERT INTO messages (session_id, role, content, tool_calls, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    sessionId,
    role,
    content,
    toolCalls ? JSON.stringify(toolCalls) : null,
    timestamp
  );

  // 更新会话的updated_at
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(timestamp, sessionId);

  return {
    id: result.lastInsertRowid as number,
    sessionId,
    role,
    content,
    toolCalls: toolCalls as any,
    timestamp,
  };
}

export function getSessionMessages(sessionId: string, limit: number = 100): Message[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(sessionId, limit) as any[];

  return rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    timestamp: row.timestamp,
  }));
}

export function clearSessionMessages(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
}
