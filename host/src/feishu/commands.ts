/**
 * Feishu Bot Commands
 *
 * Extracted from gateway.ts for better separation of concerns
 */

import type { FeishuMessage, FeishuResponse } from './types.js';
import {
    getSession,
    createSession,
    listSessions,
    clearSessionMessages,
    getSessionMessages,
    deleteSession,
    setMapping,
    deleteMapping,
    getMapping,
} from '../db/index.js';
import type { Session } from '../types.js';
import { logger } from './logger.js';

const log = logger('feishu:commands');

export interface CommandContext {
    chatId: string;
    sessionCache: Map<string, string>;
    botOpenId?: string;
}

/**
 * Parse slash command from message content
 */
export function parseCommand(content: string): { command: string; args: string } | null {
    if (!content.startsWith('/')) return null;

    const parts = content.slice(1).split(/\s+/, 2);
    return {
        command: parts[0],
        args: parts[1] || '',
    };
}

/**
 * Execute command and return response
 */
export async function executeCommand(
    command: string,
    message: FeishuMessage,
    context: CommandContext,
): Promise<FeishuResponse> {
    switch (command.toLowerCase()) {
        case 'help':
            return handleHelp();

        case 'clear':
            return handleClear(message, context);

        case 'history':
            return handleHistory(message, context);

        case 'list':
            return handleList(message, context);

        case 'new':
            return handleNew(message, context);

        case 'status':
            return handleStatus(message, context);

        default:
            return {
                text: `Unknown command: \`/${command}\`. Type \`/help\` for available commands.`,
            };
    }
}

function handleHelp(): FeishuResponse {
    return {
        text: [
            '**MomoClaw Bot Commands**',
            '',
            '`/help` - Show this help message',
            '`/clear` - Clear conversation history',
            '`/history` - Show current session message history',
            '`/list` - List all sessions',
            '`/new` - Create a new session',
            '`/status` - Show bot status',
        ].join('\n'),
    };
}

function handleClear(message: FeishuMessage, context: CommandContext): FeishuResponse {
    const session = getOrCreateSession(message, context);
    clearSessionMessages(session.id);
    return {
        text: '🗑️ Conversation context cleared. Starting fresh!',
    };
}

function handleHistory(message: FeishuMessage, context: CommandContext): FeishuResponse {
    const session = getOrCreateSession(message, context);
    const messages = getSessionMessages(session.id, 1000);

    if (messages.length === 0) {
        return {
            text: '📜 No messages in this session.',
        };
    }

    const historyLines = messages.map((msg, index) => {
        const roleEmoji = msg.role === 'user' ? '👤' : '🤖';
        const date = new Date(msg.timestamp).toLocaleString('zh-CN', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
        const preview = msg.content.length > 100
            ? msg.content.slice(0, 100) + '...'
            : msg.content;
        return `${index + 1}. ${roleEmoji} **${msg.role}** (${date})\n   > ${preview}`;
    });

    return {
        text: [
            `📜 **Session History** (${messages.length} messages)`,
            '',
            ...historyLines,
        ].join('\n'),
    };
}

function handleList(message: FeishuMessage, context: CommandContext): FeishuResponse {
    const sessions = listSessions();
    const session = getOrCreateSession(message, context);
    const sessionList = sessions
        .map((s, index) => {
            const isCurrent = s.id === session.id;
            const date = new Date(s.updatedAt).toLocaleString('zh-CN');
            const prefix = isCurrent ? '🌟 ' : '   ';
            return `${index + 1}. ${prefix}${s.name} (${date})`;
        })
        .join('\n\n');
    const text =
        sessions.length === 0
            ? 'No sessions found.'
            : `📋 **All Sessions** (${sessions.length} total):\n\n${sessionList}`;

    return { text };
}

function handleNew(message: FeishuMessage, context: CommandContext): FeishuResponse {
    const chatType = message.chatType === 'p2p' ? 'DM' : 'Group';
    const newSessionId = `feishu_${message.chatId}_${Date.now()}`;

    // Delete old session if exists (using cache to find it)
    const oldSessionId = getCachedSessionId(message.chatId, context);
    if (oldSessionId) {
        deleteSession(oldSessionId);
        log.info(`Deleted old session ${oldSessionId} for chat ${message.chatId}`);
    }

    // Create new session
    createSession(
        newSessionId,
        `Feishu ${chatType} ${message.chatId.slice(0, 8)}`,
    );

    // Update cache and persistent mapping
    context.sessionCache.set(message.chatId, newSessionId);
    setMapping(message.chatId, newSessionId);

    return {
        text: `✅ New session created! Session ID: \`${newSessionId}\``,
    };
}

function handleStatus(message: FeishuMessage, context: CommandContext): FeishuResponse {
    return {
        text: [
            '**MomoClaw Status**',
            '',
            `- Chat Type: ${message.chatType}`,
            `- Chat ID: ${message.chatId}`,
            `- Bot ID: ${context.botOpenId || 'unknown'}`,
            `- SDK: @larksuiteoapi/node-sdk`,
        ].join('\n'),
    };
}

/**
 * Get or create a session for the Feishu chat
 * Uses in-memory cache first to reduce DB queries
 */
export function getOrCreateSession(
    message: FeishuMessage,
    context: CommandContext,
): Session {
    const chatId = message.chatId;

    // 1. Check memory cache first (O(1) lookup)
    const cachedSessionId = context.sessionCache.get(chatId);
    if (cachedSessionId) {
        const session = getSession(cachedSessionId);
        if (session) {
            log.debug(`Cache hit for chat ${chatId} -> ${cachedSessionId}`);
            return session;
        }
        // Cache stale, remove it and clean up DB mapping
        context.sessionCache.delete(chatId);
        deleteMapping(chatId);
        log.debug(`Cleaned up stale cache and mapping for chat ${chatId}`);
    }

    // 2. Check persistent mapping storage
    const mapping = getMapping(chatId);
    if (mapping) {
        const session = getSession(mapping.sessionId);
        if (session) {
            // Update cache
            context.sessionCache.set(chatId, session.id);
            log.debug(`DB mapping found for chat ${chatId} -> ${session.id}`);
            return session;
        }
        // Mapping stale, clean it up
        deleteMapping(chatId);
        log.debug(`Cleaned up stale DB mapping for chat ${chatId}`);
    }

    // 3. Create new session
    const chatType = message.chatType === 'p2p' ? 'DM' : 'Group';
    const sessionId = `feishu_${chatId}_${Date.now()}`;
    const session = createSession(
        sessionId,
        `Feishu ${chatType} ${chatId.slice(0, 8)}`,
    );

    // Update both cache and persistent storage
    context.sessionCache.set(chatId, sessionId);
    setMapping(chatId, sessionId);

    log.info(`Created new session ${sessionId} for chat ${chatId}`);
    return session;
}

/**
 * Get cached session ID for a chat (for /new command to find old session)
 */
export function getCachedSessionId(
    chatId: string,
    context: CommandContext,
): string | undefined {
    // Try cache first
    const cached = context.sessionCache.get(chatId);
    if (cached) return cached;

    // Fallback to DB
    const mapping = getMapping(chatId);
    return mapping?.sessionId;
}
