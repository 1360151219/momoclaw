import Database from 'better-sqlite3';
import { dirname } from 'path';
import { ensureDirWithPerms } from '../hooks/utils.js';
import { initSessionsTable } from './sessions.js';
import { initMessagesTable } from './messages.js';
import { initTasksTable, initTaskRunLogsTable } from './tasks.js';
import { initFeishuMappingsTable } from './channels/feishuMappings.js';

let db: Database.Database | null = null;

export function initDatabase(dbPath: string): Database.Database {
  ensureDirWithPerms(dirname(dbPath));

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // 显式开启外键约束，保证 SQLite 删除级联（ON DELETE CASCADE）等特性生效
  db.pragma('foreign_keys = ON');

  // Initialize all tables
  initSessionsTable(db);
  initMessagesTable(db);
  initTasksTable(db);
  initTaskRunLogsTable(db);
  initFeishuMappingsTable(db);

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}
