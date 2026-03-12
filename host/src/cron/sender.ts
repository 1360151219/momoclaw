/**
 * Cron Task Result Sender - Channel registry for cron task notifications
 *
 * Manages channel handlers and routes task results to the appropriate channel.
 * Supports: feishu, terminal, web, and future channels.
 */

import type { ChannelType, ChannelHandler } from '../types.js';

class ChannelRegistry {
    private handlers = new Map<ChannelType, ChannelHandler>();

    /**
     * Register a channel handler
     */
    register(handler: ChannelHandler): void {
        this.handlers.set(handler.type, handler);
    }

    /**
     * Unregister a channel handler
     */
    unregister(type: ChannelType): void {
        this.handlers.delete(type);
    }

    /**
     * Get a handler by channel type
     */
    getHandler(type: ChannelType): ChannelHandler | undefined {
        return this.handlers.get(type);
    }

    /**
     * Check if a handler is available for the given channel type
     */
    isAvailable(type: ChannelType): boolean {
        const handler = this.handlers.get(type);
        return handler ? handler.isAvailable() : false;
    }

    /**
     * Send message to a specific channel
     * Returns true if message was sent, false if channel not available
     */
    async sendMessage(
        type: ChannelType,
        channelId: string,
        content: string,
    ): Promise<boolean> {
        const handler = this.handlers.get(type);
        if (!handler || !handler.isAvailable()) {
            console.log(`[ChannelRegistry] Channel ${type} not available`);
            return false;
        }

        try {
            await handler.sendMessage(channelId, content);
            return true;
        } catch (err) {
            console.error(`[ChannelRegistry] Failed to send to ${type}:`, err);
            return false;
        }
    }

    /**
     * Get all registered channel types
     */
    getRegisteredChannels(): ChannelType[] {
        return Array.from(this.handlers.keys());
    }
}

// Export singleton instance
export const channelRegistry = new ChannelRegistry();
