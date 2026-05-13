/**
 * Cron Task Result Sender - Channel registry for cron task notifications
 *
 * Manages channel handlers and routes task results to the appropriate channel.
 * Supports: feishu, terminal, web, and future channels.
 */

import type { ChannelType, ChannelHandler } from '../types.js';

class ChannelRegistry {
    private handlers = new Map<string, ChannelHandler>();

    private makeKey(type: ChannelType, wxUserId?: string): string {
        return wxUserId ? `${type}:${wxUserId}` : type;
    }

    /**
     * Register a channel handler.
     * For Weixin, pass wxUserId to register per-user handlers.
     */
    register(handler: ChannelHandler, wxUserId?: string): void {
        this.handlers.set(this.makeKey(handler.type, wxUserId), handler);
    }

    /**
     * Unregister a channel handler
     */
    unregister(type: ChannelType, wxUserId?: string): void {
        this.handlers.delete(this.makeKey(type, wxUserId));
    }

    /**
     * Get a handler by channel type and optional wxUserId
     */
    getHandler(type: ChannelType, wxUserId?: string): ChannelHandler | undefined {
        return this.handlers.get(this.makeKey(type, wxUserId));
    }

    /**
     * Check if a handler is available for the given channel type
     */
    isAvailable(type: ChannelType, wxUserId?: string): boolean {
        const handler = this.handlers.get(this.makeKey(type, wxUserId));
        return handler ? handler.isAvailable() : false;
    }

    /**
     * Send message to a specific channel.
     * For Weixin, pass wxUserId to route to the correct user's gateway.
     * Returns true if message was sent, false if channel not available.
     */
    async sendMessage(
        type: ChannelType,
        channelId: string,
        content: string,
        wxUserId?: string,
    ): Promise<boolean> {
        const handler = this.handlers.get(this.makeKey(type, wxUserId));
        if (!handler || !handler.isAvailable()) {
            console.log(`[ChannelRegistry] Channel ${type}${wxUserId ? `:${wxUserId}` : ''} not available`);
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
     * Get all registered channel types (deduplicated)
     */
    getRegisteredChannels(): ChannelType[] {
        const types = new Set<ChannelType>();
        for (const key of this.handlers.keys()) {
            const colonIdx = key.indexOf(':');
            types.add(
                (colonIdx === -1 ? key : key.slice(0, colonIdx)) as ChannelType,
            );
        }
        return Array.from(types);
    }
}

// Export singleton instance
export const channelRegistry = new ChannelRegistry();
