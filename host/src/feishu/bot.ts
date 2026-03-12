/**
 * Feishu chat integration for MomoClaw
 * Bridges Feishu messages with MomoClaw's chat system
 */

import { FeishuGateway } from './index.js';
import type { FeishuConfig, FeishuMessage } from './index.js';
import { config } from '../config.js';
import { processChat } from '../core/chatService.js';
import type { Session, ChannelContext } from '../types.js';
import { getOrCreateSession } from './commands.js';
import type { CommandContext } from './commands.js';

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

    // Initialize session cache for this bot instance
    const sessionCache = new Map<string, string>();
    const context: CommandContext = {
        chatId: '', // Will be set per message
        sessionCache,
    };

    await gateway.start({
        onStream: async (message, updater) => {
            context.chatId = message.chatId;
            await handleStreamingMessage(message, updater, context);
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

    try {
        const result = await processChat({
            content: message.content,
            session,
            channelContext,
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
