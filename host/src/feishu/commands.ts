/**
 * Feishu Bot Commands
 *
 * Extracted from gateway.ts for better separation of concerns
 */

import type { FeishuMessage, FeishuResponse } from './types.js';
import {
  getSession,
  createSession,
  getChannelMapping,
  setChannelMapping,
  deleteChannelMapping,
} from '../db/index.js';
import type { Session } from '../types.js';
import { logger } from './logger.js';

const log = logger('feishu:commands');
const CHANNEL_TYPE = 'feishu';

import {
  executeCommand as coreExecuteCommand,
  type BaseCommandContext,
  type CommandResponse,
} from '../core/commands/executor.js';

export interface CommandContext {
  chatId: string;
  sessionCache: Map<string, string>;
  botOpenId?: string;
}

/**
 * Execute command and return response
 */
export async function executeCommand(
  command: string,
  message: FeishuMessage,
  context: CommandContext,
): Promise<FeishuResponse> {
  const session = getOrCreateSession(message, context);
  const baseContext: BaseCommandContext = {
    channelId: message.chatId,
    channelType: 'feishu',
    session: session,
    botId: context.botOpenId,
    onNewSession: (oldSessionId, newSessionId) => {
      /**
       * 安全策略：/new 只切换到新 session，不删除旧 session。
       *
       * 原因：旧 session 可能仍被 scheduled_tasks 等表通过外键引用，
       * 直接删除会触发 SQLite 的 FOREIGN KEY constraint failed。
       */
      if (oldSessionId && oldSessionId !== newSessionId) {
        log.info(
          `Preserved old session ${oldSessionId} for chat ${message.chatId} (switched to ${newSessionId})`,
        );
      }

      // Update cache and persistent mapping
      context.sessionCache.set(message.chatId, newSessionId);
      setChannelMapping(CHANNEL_TYPE, message.chatId, newSessionId);
    },
  };

  const response = await coreExecuteCommand(command, baseContext);
  return {
    text: response.text,
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
    deleteChannelMapping(CHANNEL_TYPE, chatId);
    log.debug(`Cleaned up stale cache and mapping for chat ${chatId}`);
  }

  // 2. Check persistent mapping storage
  const mapping = getChannelMapping(CHANNEL_TYPE, chatId);
  if (mapping) {
    const session = getSession(mapping.sessionId);
    if (session) {
      // Update cache
      context.sessionCache.set(chatId, session.id);
      log.debug(`DB mapping found for chat ${chatId} -> ${session.id}`);
      return session;
    }
    // Mapping stale, clean it up
    deleteChannelMapping(CHANNEL_TYPE, chatId);
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
  setChannelMapping(CHANNEL_TYPE, chatId, sessionId);

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
  const mapping = getChannelMapping(CHANNEL_TYPE, chatId);
  return mapping?.sessionId;
}
