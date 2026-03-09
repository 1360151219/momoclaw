import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

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
