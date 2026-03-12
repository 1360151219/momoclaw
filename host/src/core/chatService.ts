/**
 * Core chat business logic - separated from CLI presentation layer
 * Following Single Responsibility Principle
 */

import {
  addMessage,
  getSessionMessages,
  getSession,
  updateSession,
} from '../db/index.js';
import { runContainerAgent } from '../container.js';
import { getContextWindow, compressContext } from '../hooks/index.js';
import {
  PromptPayload,
  ToolEvent,
  Session,
  ToolCall,
  ChannelContext,
} from '../types.js';
import { config, getApiConfig } from '../config.js';

export interface ChatInput {
  content: string;
  session: Session;
  /**
   * Optional callback for receiving response chunks as they arrive.
   * Enables real-time streaming output.
   */
  onChunk?: (chunk: string) => void;
  /**
   * Optional callback for tool events.
   * If provided, enables streaming tool event handling.
   */
  onToolEvent?: (event: ToolEvent) => void;
  /**
   * Optional channel context for result routing.
   * Used to push task results back to the originating channel.
   */
  channelContext?: ChannelContext;
}

export interface ChatOutput {
  content: string;
  toolCalls?: ToolCall[];
  success: boolean;
  error?: string;
}

/**
 * Core chat processing logic - platform agnostic
 * Can be used by CLI, Feishu, or other platforms
 */
export async function processChat(input: ChatInput): Promise<ChatOutput> {
  const { content, session } = input;
  const apiConfig = getApiConfig(config, session.model || undefined);

  // Save user message
  addMessage(session.id, 'user', content);

  // Get history (all messages, we use sliding window instead of deletion)
  const allMessages = getSessionMessages(session.id, 100); // Reasonable limit for context window

  // Use sliding window to get recent messages within token limit
  const contextWindow = getContextWindow(session, allMessages);

  // Trigger async context compression if threshold reached
  if (contextWindow.shouldCompress) {
    const compressionDeps = {
      getMessages: getSessionMessages,
      updateSession: updateSession,
      getSession: getSession,
      apiConfig,
    };
    // Fire and forget - don't block chat response
    compressContext(compressionDeps, session.id).catch((err) => {
      console.error('[Chat] Context compression failed:', err);
    });
  }

  // Build payload with context window
  const payload: PromptPayload = {
    session,
    messages: contextWindow.messages.slice(0, -1), // Exclude current message
    userInput: content,
    apiConfig: apiConfig,
    channelContext: input.channelContext,
    memory: {
      todayPath: '',
      recentContent: session.summary || '',
    },
  };

  let contentBuffer = '';

  try {
    const result = await runContainerAgent(
      payload,
      (chunk) => {
        contentBuffer += chunk;
        // Forward chunk to callback if provided for real-time streaming
        input.onChunk?.(chunk);
      },
      input.onToolEvent || (() => {}),
    );

    if (result.success) {
      const finalContent = contentBuffer || result.content;
      addMessage(session.id, 'assistant', finalContent, result.toolCalls);
      return {
        content: finalContent,
        toolCalls: result.toolCalls,
        success: true,
      };
    } else {
      return {
        content: '',
        success: false,
        error: result.error || 'Unknown error',
      };
    }
  } catch (err) {
    return {
      content: '',
      success: false,
      error: `Container error: ${err}`,
    };
  }
}
