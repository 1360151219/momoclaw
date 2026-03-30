import { statSync } from 'fs';
import { ScheduledTask, TaskRunLog, TaskStatus, ScheduleType, ChannelType } from '../types.js';
import { getDb } from './connection.js';

// ========== Helper Functions ==========

/**
 * Map database row to ScheduledTask object
 * Centralized mapping to avoid duplication
 */
function mapRowToScheduledTask(row: any): ScheduledTask {
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
        channelType: row.channel_type,
        channelId: row.channel_id,
    };
}

// ========== Table Initialization ==========

/**
 * Initialize the scheduled_tasks table
 */
export function initTasksTable(db: any): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron', 'interval', 'once')),
            schedule_value TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'failed')),
            next_run INTEGER,
            last_run INTEGER,
            last_result TEXT,
            run_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            channel_type TEXT CHECK(channel_type IN ('feishu', 'terminal', 'web')),
            channel_id TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_channel ON scheduled_tasks(channel_type, channel_id)`);
}

/**
 * Initialize the task_run_logs table
 */
export function initTaskRunLogsTable(db: any): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS task_run_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            executed_at INTEGER NOT NULL,
            success INTEGER NOT NULL DEFAULT 0,
            output TEXT NOT NULL DEFAULT '',
            error TEXT
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_task_logs ON task_run_logs(task_id, executed_at)`);
}

/**
 * Migrate the scheduled_tasks table to add new columns
 */
export function migrateTasksTable(db: any): void {
    const tableInfo = db.prepare('PRAGMA table_info(scheduled_tasks)').all();
    const columns = tableInfo.map((col: any) => col.name);

    if (!columns.includes('channel_type')) {
        db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN channel_type TEXT CHECK(channel_type IN ('feishu', 'terminal', 'web'))`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_channel ON scheduled_tasks(channel_type, channel_id)`);
    }

    if (!columns.includes('channel_id')) {
        db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN channel_id TEXT`);
    }
}

// ========== Scheduled Task Operations ==========

export function createScheduledTask(
    id: string,
    sessionId: string,
    prompt: string,
    scheduleType: ScheduleType,
    scheduleValue: string,
    nextRun: number,
    channelType?: ChannelType,
    channelId?: string
): ScheduledTask {
    const db = getDb();
    const now = Date.now();

    // Ensure session exists (foreign key constraint requirement)
    const existingSession = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!existingSession) {
        // Auto-create session
        db.prepare(`
            INSERT INTO sessions (id, claude_session_id, name, system_prompt, model, created_at, updated_at, is_active)
            VALUES (?, NULL, ?, ?, NULL, ?, ?, 0)
        `).run(sessionId, `Session-${sessionId.slice(-8)}`, '', now, now);
    }

    const stmt = db.prepare(`
        INSERT INTO scheduled_tasks
        (id, session_id, prompt, schedule_type, schedule_value, status, next_run, run_count, created_at, updated_at, channel_type, channel_id)
        VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?, ?)
    `);

    stmt.run(id, sessionId, prompt, scheduleType, scheduleValue, nextRun, now, now, channelType || null, channelId || null);

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
        channelType,
        channelId,
    };
}

export function getScheduledTask(id: string): ScheduledTask | undefined {
    const db = getDb();
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as any;

    if (!row) return undefined;

    return mapRowToScheduledTask(row);
}

export function listScheduledTasks(sessionId?: string): ScheduledTask[] {
    const db = getDb();

    let rows: any[];
    if (sessionId) {
        rows = db.prepare('SELECT * FROM scheduled_tasks WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as any[];
    } else {
        rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as any[];
    }

    return rows.map(mapRowToScheduledTask);
}

export function getDueTasks(now: number = Date.now()): ScheduledTask[] {
    const db = getDb();
    const rows = db.prepare(
        'SELECT * FROM scheduled_tasks WHERE next_run <= ? AND status = ? ORDER BY next_run ASC'
    ).all(now, 'active') as any[];

    return rows.map(mapRowToScheduledTask);
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
        nextRun ?? 0,
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

// ========== Cleanup Operations ==========

/**
 * Clean up old message data (session expiration cleanup)
 * @param maxAgeDays Maximum number of days to retain messages (default 30)
 * @param keepLastN Minimum number of messages to retain per session (default 10)
 */
export function cleanupOldMessages(maxAgeDays: number = 30, keepLastN: number = 10): number {
    const db = getDb();
    const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

    // Get all session IDs
    const sessions = db.prepare('SELECT id FROM sessions').all() as { id: string }[];
    let deletedCount = 0;

    for (const session of sessions) {
        // Delete old messages but retain at least keepLastN most recent messages per session
        const result = db.prepare(`
            DELETE FROM messages
            WHERE session_id = ?
              AND timestamp < ?
              AND id NOT IN (
                  SELECT id FROM messages
                  WHERE session_id = ?
                  ORDER BY timestamp DESC
                  LIMIT ?
              )
        `).run(session.id, cutoffTime, session.id, keepLastN);

        deletedCount += result.changes;
    }

    // Clean up orphaned task run logs (associated task no longer exists)
    db.prepare(`
        DELETE FROM task_run_logs
        WHERE task_id NOT IN (SELECT id FROM scheduled_tasks)
    `).run();

    // Clean up completed one-time tasks whose execution time exceeds maxAgeDays
    db.prepare(`
        DELETE FROM scheduled_tasks
        WHERE schedule_type = 'once'
          AND status = 'completed'
          AND last_run < ?
    `).run(cutoffTime);

    return deletedCount;
}

/**
 * Get database statistics
 */
export function getDatabaseStats(): {
    sessions: number;
    messages: number;
    scheduledTasks: number;
    taskRunLogs: number;
    dbSizeBytes: number;
} {
    const db = getDb();

    const sessions = (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count;
    const messages = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
    const scheduledTasks = (db.prepare('SELECT COUNT(*) as count FROM scheduled_tasks').get() as { count: number }).count;
    const taskRunLogs = (db.prepare('SELECT COUNT(*) as count FROM task_run_logs').get() as { count: number }).count;

    // Get database file size
    const dbPath = (db as any).name || '';
    let dbSizeBytes = 0;
    try {
        if (dbPath) {
            dbSizeBytes = statSync(dbPath).size;
        }
    } catch {
        // Ignore errors
    }

    return { sessions, messages, scheduledTasks, taskRunLogs, dbSizeBytes };
}
