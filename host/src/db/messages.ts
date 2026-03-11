import { Message } from '../types.js';
import { getDb } from './connection.js';

/**
 * Initialize the messages table
 */
export function initMessagesTable(db: any): void {
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
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)`);
}

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
