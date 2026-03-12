/**
 * Feishu Cron Handler - Routes cron task results to Feishu chats
 *
 * Implements ChannelHandler interface for cron task result delivery.
 */

import type { ChannelHandler, ChannelType } from '../types.js';
import { FeishuSender } from './sender.js';
import type { FeishuConfig } from './types.js';

export class FeishuCronHandler implements ChannelHandler {
    readonly type: ChannelType = 'feishu';
    private sender?: FeishuSender;

    constructor(config?: FeishuConfig) {
        if (config?.appId && config?.appSecret) {
            this.sender = new FeishuSender(config);
        }
    }

    /**
     * Update config (called when config changes)
     */
    updateConfig(config: FeishuConfig): void {
        if (config.appId && config.appSecret) {
            this.sender = new FeishuSender(config);
        } else {
            this.sender = undefined;
        }
    }

    isAvailable(): boolean {
        return this.sender !== undefined;
    }

    async sendMessage(chatId: string, content: string): Promise<void> {
        if (!this.sender) {
            throw new Error('Feishu sender not initialized');
        }

        // Format as scheduled task result
        const formatted = this.formatTaskResult(content);
        await this.sender.sendText(chatId, formatted);
    }

    private formatTaskResult(content: string): string {
        return ['🤖 **定时任务执行结果**', '', '---', '', content].join('\n');
    }
}
