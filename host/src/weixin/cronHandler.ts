/**
 * Weixin Cron Handler - Routes cron task results to Weixin chats
 *
 * Implements ChannelHandler interface for cron task result delivery.
 * Each WeixinUser gets their own handler instance with a reference to their gateway.
 */

import type { ChannelHandler, ChannelType } from '../types.js';
import { WeixinGateway } from './gateway.js';

export class WeixinCronHandler implements ChannelHandler {
    readonly type: ChannelType = 'weixin';
    private gateway: WeixinGateway | undefined;

    constructor(gateway?: WeixinGateway) {
        this.gateway = gateway;
    }

    isAvailable(): boolean {
        return this.gateway !== undefined;
    }

    async sendMessage(chatId: string, content: string): Promise<void> {
        if (!this.gateway) {
            throw new Error('Weixin gateway not initialized');
        }

        // Format as scheduled task result
        const formatted = this.formatTaskResult(content);

        const client = this.gateway.getClient();

        if (!client.hasToken()) {
            throw new Error('Weixin token not available. Please ensure the bot is logged in.');
        }

        // Use the latest stored context token for this chat
        const currentToken = this.gateway.getContextToken(chatId) || '';

        await client.sendTextMessage(chatId, formatted, currentToken);
    }

    private formatTaskResult(content: string): string {
        return ['🤖 [定时任务执行结果]', '', '---', '', content].join('\n');
    }
}