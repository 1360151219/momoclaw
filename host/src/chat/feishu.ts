/**
 * Feishu chat integration for MomoClaw
 * Bridges Feishu messages with MomoClaw's chat system
 */

import { FeishuGateway } from '../feishu/index.js';
import type { FeishuConfig, FeishuMessage } from '../feishu/index.js';
import {
  getSession,
  createSession,
  listSessions,
} from '../db/index.js';
import { config } from '../config.js';
import { processChat } from './index.js';
import type { Session } from '../types.js';

interface FeishuChatOptions {
  feishuConfig: FeishuConfig;
}

/**
 * Start Feishu bot service with streaming support
 */
export async function startFeishuBot(
  options: FeishuChatOptions,
): Promise<void> {
  const gateway = new FeishuGateway(options.feishuConfig);

  await gateway.start({
    onStream: async (message, updater) => {
      await handleStreamingMessage(message, updater);
    },
  });
}

/**
 * Handle incoming Feishu message with streaming response
 */
async function handleStreamingMessage(
  message: FeishuMessage,
  updater: {
    updateThinking: (text: string) => Promise<void>;
    updateContent: (text: string) => Promise<void>;
    appendToolUse: (name: string, input: unknown) => Promise<void>;
    finalize: (response: {
      text: string;
      thinking?: string;
      model?: string;
      elapsedMs?: number;
    }) => Promise<void>;
  },
): Promise<void> {
  const startTime = Date.now();

  // Get or create session for this chat
  const session = getOrCreateSession(message);

  let responseText = '';
  let thinkingText = '';

  try {
    const result = await processChat({
      content: message.content,
      session,
      onChunk: (chunk) => {
        console.log('[streaming chunk]', chunk);
        responseText += chunk;
        // Stream content updates in real-time
        updater.updateContent(responseText).catch(() => {});
      },
      onToolEvent: (event) => {
        if (event.type === 'thinking') {
          console.log(`[streaming event ${event.type}]`, event.content);
          thinkingText += event.content;
          // Stream thinking updates in real-time
          updater.updateThinking(thinkingText).catch(() => {});
        } else if (event.type === 'tool_use') {
          const toolCall = event.toolCall;
          const toolInfo = `\n🔧 **Tool Use**: \`${toolCall.name}\`\n\`\`\`json\n${JSON.stringify(toolCall.arguments, null, 2)}\n\`\`\`\n`;
          thinkingText += toolInfo;
          console.log(`[streaming event ${event.type}]`, toolCall.name);
          updater.updateThinking(thinkingText).catch(() => {});
        } else if (event.type === 'tool_result') {
          const resultInfo = `\n✅ **Tool Result** (ID: ${event.toolCallId}):\n\`\`\`\n${event.result.slice(0, 500)}${event.result.length > 500 ? '...' : ''}\n\`\`\`\n`;
          thinkingText += resultInfo;
          console.log(`[streaming event ${event.type}]`, event.toolCallId);
          updater.updateThinking(thinkingText).catch(() => {});
        }
      },
    });

    if (result.success) {
      await updater.finalize({
        text: result.content,
        thinking: thinkingText || undefined,
        model: session.model || config.defaultModel,
        elapsedMs: Date.now() - startTime,
      });
    } else {
      await updater.finalize({
        text: `❌ Error: ${result.error || 'Unknown error'}`,
        model: session.model || config.defaultModel,
        elapsedMs: Date.now() - startTime,
      });
    }
  } catch (err) {
    await updater.finalize({
      text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
      model: session.model || config.defaultModel,
      elapsedMs: Date.now() - startTime,
    });
  }
}

/**
 * Get or create a session for the Feishu chat
 * Supports finding the latest session (including timestamped ones from /new command)
 */
function getOrCreateSession(message: FeishuMessage): Session {
  const baseSessionId = `feishu_${message.chatId}`;

  // Try to find existing session - first exact match, then look for timestamped ones
  let session = getSession(baseSessionId);

  if (!session) {
    // Look for timestamped sessions from /new command
    const allSessions = listSessions();
    const chatSessions = allSessions.filter(
      (s) => s.id.startsWith(`${baseSessionId}_`) || s.id === baseSessionId,
    );

    if (chatSessions.length > 0) {
      // Return the most recently updated session for this chat
      session = chatSessions[0];
    }
  }

  if (!session) {
    const chatType = message.chatType === 'p2p' ? 'DM' : 'Group';
    session = createSession(
      baseSessionId,
      `Feishu ${chatType} ${message.chatId.slice(0, 8)}`,
    );
  }

  return session;
}
