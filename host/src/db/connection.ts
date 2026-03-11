import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { initSessionsTable, migrateSessionsTable } from './sessions.js';
import { initMessagesTable } from './messages.js';
import { initTasksTable, initTaskRunLogsTable } from './tasks.js';
import { initFeishuMappingsTable } from './channels/feishuMappings.js';

let db: Database.Database | null = null;

export function initDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Initialize all tables
  initSessionsTable(db);
  initMessagesTable(db);
  initTasksTable(db);
  initTaskRunLogsTable(db);
  initFeishuMappingsTable(db);

  // Run migrations
  migrateSessionsTable(db);

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}
