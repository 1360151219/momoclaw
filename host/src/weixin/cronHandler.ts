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
        
        // Ensure gateway has a valid client token by starting it briefly if needed
        // Note: In a real long-running scenario, the bot is already started and has the token.
        // If it's a standalone cron process, it might need to get token.
        const client = this.gateway.getClient();
        
        // We use an empty context token here as this is an active push, not a reply
        // Weixin might require a valid context token, but for active pushes we might need to rely on the latest stored one
        const currentToken = this.gateway.getContextToken(chatId) || '';
        
        await client.sendTextMessage(chatId, formatted, currentToken);
    }

    private formatTaskResult(content: string): string {
        return ['🤖 [定时任务执行结果]', '', '---', '', content].join('\n');
    }
}