/**
 * Feishu Bot Example
 * Demonstrates how to use the new SDK-based Feishu integration
 */

import { FeishuGateway } from '../feishu/index.js';
import dotenv from 'dotenv';

dotenv.config();

const config = {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    domain: (process.env.FEISHU_DOMAIN as 'feishu' | 'lark') || 'feishu',
    autoReplyGroups: process.env.FEISHU_AUTO_REPLY_GROUPS?.split(',') || [],
};

async function main() {
    if (!config.appId || !config.appSecret) {
        console.error('Please set FEISHU_APP_ID and FEISHU_APP_SECRET environment variables');
        process.exit(1);
    }

    const gateway = new FeishuGateway(config);

    // Example 1: Simple echo bot
    console.log('Starting simple echo bot...');
    await gateway.start({
        onMessage: async (message) => {
            console.log(`[${message.chatType}] ${message.senderId}: ${message.content}`);

            // Handle slash commands
            if (message.content.startsWith('/')) {
                return handleCommand(message.content);
            }

            // Simple echo
            return {
                text: `🤖 **Echo:**\n\n${message.content}`,
                model: 'echo-bot',
                elapsedMs: 0,
            };
        },
    });
}

// Example 2: Streaming AI bot (uncomment to use)
async function streamingExample() {
    const gateway = new FeishuGateway(config);

    await gateway.start({
        onStream: async (message, updater) => {
            console.log(`Streaming response for: ${message.content}`);

            // Simulate AI thinking
            await updater.updateThinking('Analyzing your message...');
            await delay(500);

            // Stream response word by word
            const response = 'This is a simulated streaming response from the AI!';
            const words = response.split(' ');

            for (let i = 0; i < words.length; i++) {
                await updater.updateContent(words.slice(0, i + 1).join(' '));
                await delay(100);
            }

            // Simulate a tool use
            await updater.appendToolUse('search', { query: 'example' });
            await delay(300);

            // Finalize with stats
            await updater.finalize({
                text: response,
                thinking: 'Analysis complete',
                model: 'claude-3-sonnet',
                elapsedMs: 2000,
                inputTokens: 100,
                outputTokens: 50,
            });
        },
    });
}

function handleCommand(content: string) {
    const command = content.slice(1).split(' ')[0].toLowerCase();

    switch (command) {
        case 'help':
            return {
                text: [
                    '**Available Commands:**',
                    '',
                    '`/help` - Show this help message',
                    '`/ping` - Check bot status',
                    '`/time` - Get current time',
                ].join('\n'),
            };

        case 'ping':
            return {
                text: '🏓 Pong! Bot is running.',
            };

        case 'time':
            return {
                text: `🕐 Current time: ${new Date().toLocaleString()}`,
            };

        default:
            return {
                text: `Unknown command: \`${command}\`. Type \`/help\` for available commands.`,
            };
    }
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
