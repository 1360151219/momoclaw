/**
 * Weixin Cron Handler - Routes cron task results to Weixin chats
 *
 * Implements ChannelHandler interface for cron task result delivery.
 */

import type { ChannelHandler, ChannelType } from '../types.js';
import type { WeixinConfig } from './types.js';
import { WeixinGateway } from './gateway.js';

export class WeixinCronHandler implements ChannelHandler {
    readonly type: ChannelType = 'weixin';
    private gateway?: WeixinGateway;

    constructor(config?: WeixinConfig) {
        if (config) {
            this.gateway = new WeixinGateway(config);
        }
    }

    /**
     * Update config (called when config changes)
     */
    updateConfig(config: WeixinConfig): void {
        if (config) {
            this.gateway = new WeixinGateway(config);
        } else {
            this.gateway = undefined;
        }
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

        // Ensure client has a valid token by loading from local file
        // The bot process should have already saved the token when it logged in
        const hasToken = client.loadLocalToken();
        if (!hasToken) {
            throw new Error('Weixin token not available. Please ensure the bot is logged in.');
        }

        // We use an empty context token here as this is an active push, not a reply
        // Weixin might require a valid context token, but for active pushes we might need to rely on the latest stored one
        const currentToken = this.gateway.getContextToken(chatId) || '';

        await client.sendTextMessage(chatId, formatted, currentToken);
    }

    private formatTaskResult(content: string): string {
        return ['🤖 [定时任务执行结果]', '', '---', '', content].join('\n');
    }
}