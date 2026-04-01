import {
  clearSessionMessages,
  getSessionMessages,
  listSessions,
  createSession,
} from '../../db/index.js';
import type { Session } from '../../types.js';

export interface BaseCommandContext {
  channelId: string;
  channelType: 'feishu' | 'weixin' | 'cli';
  session: Session;
  botId?: string;
  onNewSession?: (oldSessionId: string, newSessionId: string) => void;
}

export interface CommandResponse {
  text: string;
}

export async function executeCommand(
  command: string,
  context: BaseCommandContext,
): Promise<CommandResponse> {
  switch (command.toLowerCase()) {
    case 'help':
      return handleHelp();
    case 'clear':
      return handleClear(context);
    case 'history':
      return handleHistory(context);
    case 'list':
      return handleList(context);
    case 'new':
      return handleNew(context);
    case 'status':
      return handleStatus(context);
    default:
      return {
        text: `Unknown command: \`/${command}\`. Type \`/help\` for available commands.`,
      };
  }
}

function handleHelp(): CommandResponse {
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

function handleClear(context: BaseCommandContext): CommandResponse {
  clearSessionMessages(context.session.id);
  return {
    text: '🗑️ Conversation context cleared. Starting fresh!',
  };
}

function handleHistory(context: BaseCommandContext): CommandResponse {
  const messages = getSessionMessages(context.session.id, 1000);

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
    const preview =
      msg.content.length > 100
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

function handleList(context: BaseCommandContext): CommandResponse {
  const sessions = listSessions();
  const sessionList = sessions
    .map((s, index) => {
      const isCurrent = s.id === context.session.id;
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

function handleNew(context: BaseCommandContext): CommandResponse {
  const newSessionId = `${context.channelType}_${context.channelId}_${Date.now()}`;

  // Create new session
  createSession(
    newSessionId,
    `${context.channelType} Chat ${context.channelId.slice(0, 8)}`,
  );

  // Call hook if provided
  if (context.onNewSession) {
    context.onNewSession(context.session.id, newSessionId);
  }

  return {
    text: `✅ New session created! Session ID: \`${newSessionId}\``,
  };
}

function handleStatus(context: BaseCommandContext): CommandResponse {
  return {
    text: [
      '**MomoClaw Status**',
      '',
      `- Channel: ${context.channelType}`,
      `- Channel ID: ${context.channelId}`,
      `- Bot ID: ${context.botId || 'unknown'}`,
    ].join('\n'),
  };
}
