/**
 * Feishu module for MomoClaw
 * Clean integration using @larksuiteoapi/node-sdk official SDK
 */

// Main exports
export { FeishuGateway } from './gateway.js';
export { FeishuSender, STREAM_EL } from './sender.js';
export { parseMessage } from './receiver.js';
export { parseCommand, executeCommand, getOrCreateSession } from './commands.js';
export type { CommandContext } from './commands.js';
export { startFeishuBot } from './bot.js';
export { FeishuCronHandler } from './cronHandler.js';

// SDK client utilities
export {
    getHttpClient,
    getWsClient,
    getEventDispatcher,
    fetchBotInfo,
    toCredentials,
    clearClientCache,
} from './client.js';
export type { RawMessageEvent, BotCredentials, BotInfo } from './client.js';

// Types
export type {
    FeishuConfig,
    FeishuMessage,
    FeishuResponse,
    MessageHandler,
} from './types.js';

// Gateway types
export type { GatewayOptions, StreamHandler, StreamUpdater } from './gateway.js';
