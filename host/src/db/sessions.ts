import { Session } from '../types.js';
import { getDb } from './connection.js';

/**
 * Initialize the sessions table
 */
export function initSessionsTable(db: any): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            system_prompt TEXT NOT NULL DEFAULT '',
            model TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 0,
            summary TEXT,
            last_consolidated_index INTEGER DEFAULT -1
        )
    `);
}

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
        summary: undefined,
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
        summary: row.summary,
        lastConsolidatedIndex: row.last_consolidated_index ?? -1,
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
        summary: row.summary,
        lastConsolidatedIndex: row.last_consolidated_index ?? -1,
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
        summary: row.summary,
        lastConsolidatedIndex: row.last_consolidated_index ?? -1,
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

export function updateSessionSummary(id: string, summary: string): boolean {
    const db = getDb();
    const result = db.prepare('UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?')
        .run(summary, Date.now(), id);
    return result.changes > 0;
}

export function updateSessionConsolidation(
    id: string,
    summary: string,
    lastConsolidatedIndex: number
): boolean {
    const db = getDb();
    const result = db.prepare(
        'UPDATE sessions SET summary = ?, last_consolidated_index = ?, updated_at = ? WHERE id = ?'
    ).run(summary, lastConsolidatedIndex, Date.now(), id);
    return result.changes > 0;
}

export function updateSession(
    id: string,
    updates: { summary?: string; lastConsolidatedIndex?: number }
): boolean {
    const db = getDb();
    const fields: string[] = [];
    const values: (string | number)[] = [];

    if (updates.summary !== undefined) {
        fields.push('summary = ?');
        values.push(updates.summary);
    }

    if (updates.lastConsolidatedIndex !== undefined) {
        fields.push('last_consolidated_index = ?');
        values.push(updates.lastConsolidatedIndex);
    }

    if (fields.length === 0) {
        return false;
    }

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    const result = db.prepare(
        `UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`
    ).run(...values);

    return result.changes > 0;
}

export function migrateSessionsTable(db: any): void {
    // Check if summary column exists
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as any[];
    const hasSummary = columns.some(col => col.name === 'summary');

    if (!hasSummary) {
        db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT');
    }

    // Check if last_consolidated_index column exists
    const hasConsolidatedIndex = columns.some(col => col.name === 'last_consolidated_index');

    if (!hasConsolidatedIndex) {
        db.exec('ALTER TABLE sessions ADD COLUMN last_consolidated_index INTEGER DEFAULT -1');
    }
}
