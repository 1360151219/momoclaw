/**
 * Core chat business logic - separated from CLI presentation layer
 * Following Single Responsibility Principle
 */

import {
  addMessage,
  updateSessionSummary,
  updateSession,
} from '../db/index.js';
import { runContainerAgent } from '../container.js';
import {
  PromptPayload,
  ToolEvent,
  Session,
  ToolCall,
  ChannelContext,
} from '../types.js';
import { config, getApiConfig } from '../config.js';
import { sessionQueue } from './sessionQueue.js';

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

  return sessionQueue.enqueue(session.id, async () => {
    const apiConfig = getApiConfig(config, session.model || undefined);

    // Save user message
    addMessage(session.id, 'user', content);

    // Update payload to only send the current user input and let the container use SDK's resume feature
    const payload: PromptPayload = {
      session,
      messages: [], // 传空数组，因为容器端将使用 resume
      userInput: content,
      apiConfig: apiConfig,
      channelContext: input.channelContext,
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
        const message = addMessage(
          session.id,
          'assistant',
          finalContent,
          result.toolCalls,
        );

        // 处理来自容器的压缩上下文摘要
        if (result.compactedSummary) {
          // 更新数据库的压缩游标和摘要，保留所有原始消息供查看
          updateSessionSummary(session.id, result.compactedSummary);
        }

        // 记录由 SDK 分配的 session id
        if (result.claudeSessionId) {
          updateSession(session.id, {
            claudeSessionId: result.claudeSessionId,
          });
        }

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
  });
}
