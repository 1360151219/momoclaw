import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { Message, Session, ScheduledTask, TaskRunLog, ScheduleType, TaskStatus } from './types.js';

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
      sdk_session_id TEXT,
      sdk_resume_at TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0
    )
  `);

  // 迁移：为已存在的表添加新列
  const pragmaTable = db.prepare("PRAGMA table_info(sessions)").all() as any[];
  const hasSdkSessionId = pragmaTable.some((col: any) => col.name === 'sdk_session_id');
  const hasSdkResumeAt = pragmaTable.some((col: any) => col.name === 'sdk_resume_at');

  if (!hasSdkSessionId) {
    db.exec('ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT');
  }
  if (!hasSdkResumeAt) {
    db.exec('ALTER TABLE sessions ADD COLUMN sdk_resume_at TEXT');
  }

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

  // 创建 scheduled_tasks 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron', 'interval', 'once')),
      schedule_value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'failed')),
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // 创建 task_run_logs 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      executed_at INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 0,
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_logs ON task_run_logs(task_id, executed_at)`);

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
    INSERT INTO sessions (id, name, system_prompt, model, sdk_session_id, sdk_resume_at, created_at, updated_at, is_active)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 1)
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
    sdkSessionId: row.sdk_session_id || undefined,
    sdkResumeAt: row.sdk_resume_at || undefined,
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
    sdkSessionId: row.sdk_session_id || undefined,
    sdkResumeAt: row.sdk_resume_at || undefined,
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
    sdkSessionId: row.sdk_session_id || undefined,
    sdkResumeAt: row.sdk_resume_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isActive: row.is_active === 1,
  }));
}

export function switchSession(id: string): boolean {
  const db = getDb();

  // 检查会话是否存在·
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

export function updateSessionSdkState(id: string, sdkSessionId?: string, sdkResumeAt?: string): boolean {
  const db = getDb();
  const result = db.prepare('UPDATE sessions SET sdk_session_id = ?, sdk_resume_at = ?, updated_at = ? WHERE id = ?')
    .run(sdkSessionId || null, sdkResumeAt || null, Date.now(), id);
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

// ========== Scheduled Task Operations ==========

export function createScheduledTask(
  id: string,
  sessionId: string,
  prompt: string,
  scheduleType: ScheduleType,
  scheduleValue: string,
  nextRun: number
): ScheduledTask {
  const db = getDb();
  const now = Date.now();

  // 确保 session 存在（外键约束要求）
  const existingSession = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!existingSession) {
    // 自动创建 session
    db.prepare(`
      INSERT INTO sessions (id, name, system_prompt, model, sdk_session_id, sdk_resume_at, created_at, updated_at, is_active)
      VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, 0)
    `).run(sessionId, `Session-${sessionId.slice(-8)}`, '', now, now);
  }

  const stmt = db.prepare(`
    INSERT INTO scheduled_tasks
    (id, session_id, prompt, schedule_type, schedule_value, status, next_run, run_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?)
  `);

  stmt.run(id, sessionId, prompt, scheduleType, scheduleValue, nextRun, now, now);

  return {
    id,
    sessionId,
    prompt,
    scheduleType,
    scheduleValue,
    status: 'active',
    nextRun,
    runCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function getScheduledTask(id: string): ScheduledTask | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as any;

  if (!row) return undefined;

  return {
    id: row.id,
    sessionId: row.session_id,
    prompt: row.prompt,
    scheduleType: row.schedule_type,
    scheduleValue: row.schedule_value,
    status: row.status,
    nextRun: row.next_run,
    lastRun: row.last_run,
    lastResult: row.last_result,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listScheduledTasks(sessionId?: string): ScheduledTask[] {
  const db = getDb();

  let rows: any[];
  if (sessionId) {
    rows = db.prepare('SELECT * FROM scheduled_tasks WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as any[];
  } else {
    rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as any[];
  }

  return rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    prompt: row.prompt,
    scheduleType: row.schedule_type,
    scheduleValue: row.schedule_value,
    status: row.status,
    nextRun: row.next_run,
    lastRun: row.last_run,
    lastResult: row.last_result,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getDueTasks(now: number = Date.now()): ScheduledTask[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM scheduled_tasks WHERE next_run <= ? AND status = ? ORDER BY next_run ASC'
  ).all(now, 'active') as any[];

  return rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    prompt: row.prompt,
    scheduleType: row.schedule_type,
    scheduleValue: row.schedule_value,
    status: row.status,
    nextRun: row.next_run,
    lastRun: row.last_run,
    lastResult: row.last_result,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function updateTaskAfterRun(
  taskId: string,
  nextRun: number | null,
  lastResult: string,
  status?: TaskStatus
): void {
  const db = getDb();
  const now = Date.now();

  const finalStatus = status || (nextRun === null ? 'completed' : 'active');

  db.prepare(`
    UPDATE scheduled_tasks
    SET next_run = ?,
        last_run = ?,
        last_result = ?,
        run_count = run_count + 1,
        status = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    nextRun,
    now,
    lastResult,
    finalStatus,
    now,
    taskId
  );
}

export function updateTaskStatus(taskId: string, status: TaskStatus): boolean {
  const db = getDb();
  const result = db.prepare(
    'UPDATE scheduled_tasks SET status = ?, updated_at = ? WHERE id = ?'
  ).run(status, Date.now(), taskId);
  return result.changes > 0;
}

export function updateTaskNextRun(taskId: string, nextRun: number): boolean {
  const db = getDb();
  const result = db.prepare(
    'UPDATE scheduled_tasks SET next_run = ?, updated_at = ? WHERE id = ?'
  ).run(nextRun, Date.now(), taskId);
  return result.changes > 0;
}

export function deleteScheduledTask(taskId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(taskId);
  return result.changes > 0;
}

// ========== Task Run Log Operations ==========

export function addTaskRunLog(
  taskId: string,
  success: boolean,
  output: string,
  error?: string
): TaskRunLog {
  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO task_run_logs (task_id, executed_at, success, output, error)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(taskId, now, success ? 1 : 0, output, error || null);

  return {
    id: result.lastInsertRowid as number,
    taskId,
    executedAt: now,
    success,
    output,
    error,
  };
}

export function getTaskRunLogs(taskId: string, limit: number = 10): TaskRunLog[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM task_run_logs
    WHERE task_id = ?
    ORDER BY executed_at DESC
    LIMIT ?
  `).all(taskId, limit) as any[];

  return rows.map(row => ({
    id: row.id,
    taskId: row.task_id,
    executedAt: row.executed_at,
    success: row.success === 1,
    output: row.output,
    error: row.error,
  }));
}
