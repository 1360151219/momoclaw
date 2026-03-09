import { Session } from '../types.js';
import { getDb } from './connection.js';

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
