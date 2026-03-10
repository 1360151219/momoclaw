/**
 * Feishu/Lark types and interfaces
 * Minimal type definitions for MomoClaw integration
 */

export interface FeishuConfig {
    appId: string;
    appSecret: string;
    encryptKey?: string;
    verificationToken?: string;
    domain?: 'feishu' | 'lark';
    /** Group chat IDs where bot auto-replies without @mention */
    autoReplyGroups?: string[];
}

export interface FeishuMessage {
    id: string;
    chatId: string;
    chatType: 'p2p' | 'group';
    senderId: string;
    senderName?: string;
    content: string;
    msgType: string;
    threadId?: string;
    parentId?: string;
    mentions?: Array<{
        id: { open_id?: string };
        name: string;
    }>;
    createTime?: number;
}

export interface FeishuResponse {
    text: string;
    thinking?: string;
    model?: string;
    elapsedMs?: number;
    inputTokens?: number;
    outputTokens?: number;
}

export type MessageHandler = (message: FeishuMessage) => Promise<FeishuResponse>;
