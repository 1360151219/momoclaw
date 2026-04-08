/**
 * Feishu chat integration for MomoClaw
 * Bridges Feishu messages with MomoClaw's chat system
 */

import {
  FeishuGateway,
  downloadImageResource,
  toCredentials,
} from './index.js';
import type { FeishuConfig, FeishuMessage, ImageAttachment } from './index.js';
import { config } from '../config.js';
import { processChat } from '../core/chatService.js';
import type { Session, ChannelContext } from '../types.js';
import { getOrCreateSession } from './commands.js';
import type { CommandContext } from './commands.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { useThrottleFn } from '../hooks/throttle.js';

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

  gateway.start({
    onStream: async (message, updater, sessionCache) => {
      const context: CommandContext = {
        chatId: message.chatId,
        sessionCache, // Shared cache from gateway
      };
      await handleStreamingMessage(message, updater, context);
    },
  });
}

/**
 * Download and save image to workspace temp directory (accessible from container)
 * Returns both host path and container path
 */
async function downloadAndSaveImage(
  image: ImageAttachment,
  messageId: string,
  creds: ReturnType<typeof toCredentials>,
): Promise<{ hostPath: string; containerPath: string } | null> {
  // Save to workspaceDir so it's accessible from container
  const tempDir = resolve(config.workspaceDir, 'temp', 'feishu-images');
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  const fileName = `${Date.now()}_${image.fileKey}.jpg`;
  const hostPath = join(tempDir, fileName);

  const result = await downloadImageResource(
    creds,
    hostPath,
    messageId,
    image.fileKey,
  );

  if (!result.ok) {
    console.error(`[Feishu] Failed to download image: ${result.error}`);
    return null;
  }

  // Container sees workspaceDir as /workspace/files
  const containerPath = join(
    '/workspace/files',
    'temp',
    'feishu-images',
    fileName,
  );

  return { hostPath, containerPath };
}

/**
 * Process images for a message: download and format as <image: path> tags
 * Uses container paths so Agent can read the images
 */
async function processImagesForMessage(
  message: FeishuMessage,
  feishuConfig: FeishuConfig,
): Promise<string> {
  if (!message.images?.length) {
    return message.content;
  }

  const creds = toCredentials(feishuConfig);
  const containerPaths: string[] = [];

  for (const image of message.images) {
    const path = await downloadAndSaveImage(image, message.id, creds);
    if (path) containerPaths.push(path.containerPath);
  }

  if (!containerPaths.length) {
    return message.content;
  }

  const imageTags = containerPaths.map((p) => `<image: ${p}>`).join('\n');
  return `${message.content.trim()}\n${imageTags}`;
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
  context: CommandContext,
): Promise<void> {
  const startTime = Date.now();

  // Get or create session for this chat (with caching)
  const session = getOrCreateSession(message, context);

  // Build channel context for result routing
  const channelContext: ChannelContext = {
    type: 'feishu',
    channelId: message.chatId,
  };

  let responseText = '';
  let thinkingText = '';

  const throttledUpdateContent = useThrottleFn((text: string) => {
    updater.updateContent(text).catch(() => {});
  });

  const throttledUpdateThinking = useThrottleFn((text: string) => {
    updater.updateThinking(text).catch(() => {});
  });

  const feishuConfig = config.feishu;
  const processedContent = feishuConfig
    ? await processImagesForMessage(message, feishuConfig)
    : message.content;

  try {
    const result = await processChat({
      content: processedContent,
      session,
      channelContext,
      onChunk: (chunk) => {
        // process.stdout.write(chunk);
        responseText += chunk;
        throttledUpdateContent(responseText);
      },
      onToolEvent: (event) => {
        if (event.type === 'thinking') {
          thinkingText += event.content;
          throttledUpdateThinking(thinkingText);
        } else if (event.type === 'tool_use') {
          const toolCall = event.toolCall;
          const toolInfo = `\n🔧 **Tool Use**: \`${toolCall.name}\`\n\`\`\`json\n${JSON.stringify(toolCall.arguments, null, 2)}\n\`\`\`\n`;
          thinkingText += toolInfo;
          throttledUpdateThinking(thinkingText);
        } else if (event.type === 'tool_result') {
          const resultInfo = `\n✅ **Tool Result** (ID: ${event.toolCallId}):\n\`\`\`\n${event.result.slice(0, 500)}${event.result.length > 500 ? '...' : ''}\n\`\`\`\n`;
          thinkingText += resultInfo;
          throttledUpdateThinking(thinkingText);
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
