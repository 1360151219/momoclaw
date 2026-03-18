/**
 * Feishu message receiver and parser
 * Handles message deduplication and content extraction
 * Works with @larksuiteoapi/node-sdk event format
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './logger.js';
import type { FeishuConfig, FeishuMessage, ImageAttachment } from './types.js';
import type { RawMessageEvent } from './client.js';

const log = logger('feishu:receiver');

// Deduplication settings
const DEDUP_TTL_MS = 10 * 60 * 1000;
const DEDUP_MAX_SIZE = 1000;
const DEDUP_FILE = join(process.cwd(), 'data', 'feishu-dedup.json');

class MessageDeduplicator {
    private seen = new Map<string, number>();

    constructor() {
        this.load();
    }

    isSeen(messageId: string): boolean {
        const now = Date.now();

        if (this.seen.size > DEDUP_MAX_SIZE * 0.8) {
            for (const [id, ts] of this.seen) {
                if (now - ts > DEDUP_TTL_MS) {
                    this.seen.delete(id);
                }
            }
        }

        return this.seen.has(messageId);
    }

    markSeen(messageId: string): void {
        this.seen.set(messageId, Date.now());
        this.persist();
    }

    private load(): void {
        try {
            if (!existsSync(DEDUP_FILE)) return;
            const data = JSON.parse(readFileSync(DEDUP_FILE, 'utf-8'));
            const now = Date.now();
            for (const [id, ts] of Object.entries(data)) {
                if (now - (ts as number) < DEDUP_TTL_MS) {
                    this.seen.set(id, ts as number);
                }
            }
        } catch {
            // Ignore load errors
        }
    }

    private persist(): void {
        try {
            const dir = dirname(DEDUP_FILE);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const data = Object.fromEntries(this.seen);
            writeFileSync(DEDUP_FILE, JSON.stringify(data));
        } catch {
            // Ignore persist errors
        }
    }
}

const deduplicator = new MessageDeduplicator();

/**
 * Parse raw message event from SDK to FeishuMessage
 */
export function parseMessage(
    event: RawMessageEvent,
    config: FeishuConfig,
    botOpenId?: string
): FeishuMessage | null {
    const msg = event.message;
    if (!msg) return null;

    // Deduplication check
    if (deduplicator.isSeen(msg.message_id)) {
        return null;
    }
    deduplicator.markSeen(msg.message_id);

    const senderId = event.sender?.sender_id?.open_id || '';
    const isMentioned = msg.mentions?.some((m) => m.id.open_id === botOpenId) ?? false;
    const isAutoReplyGroup = config.autoReplyGroups?.includes(msg.chat_id) ?? false;

    // In group chats, only respond when mentioned or in auto-reply groups
    if (msg.chat_type === 'group' && !isMentioned && !isAutoReplyGroup) {
        return null;
    }

    // Parse content based on message type
    const { content, images } = extractContent(msg.content, msg.message_type);

    return {
        id: msg.message_id,
        chatId: msg.chat_id,
        chatType: msg.chat_type,
        senderId,
        content,
        msgType: msg.message_type,
        threadId: msg.thread_id,
        parentId: msg.parent_id,
        mentions: msg.mentions,
        images,
    };
}

interface ExtractResult {
    content: string;
    images?: ImageAttachment[];
}

function extractContent(content: string, msgType: string): ExtractResult {
    log.info(`Extracting content from message type ${msgType}`);
    try {
        const parsed = JSON.parse(content);

        switch (msgType) {
            case 'text':
                return { content: parsed.text || '' };

            case 'post': {
                const { text, images } = extractRichText(parsed);
                return { content: text, images };
            }

            case 'image': {
                const fileKey = parsed.file_key || parsed.image_key;
                const images: ImageAttachment[] = fileKey
                    ? [{ fileKey, type: 'image' }]
                    : [];
                return { content: '', images };
            }

            case 'file':
                return { content: `[file: ${parsed.file_name || 'unknown'}]` };

            case 'audio':
                return { content: '<audio>' };

            case 'video':
                return { content: '<video>' };

            default:
                return { content };
        }
    } catch {
        return { content };
    }
}

interface RichTextResult {
    text: string;
    images: ImageAttachment[];
}

function extractRichText(parsed: Record<string, unknown>): RichTextResult {
    const title = parsed.title as string;
    const content = parsed.content as Array<Array<Record<string, unknown>>>;

    let text = title ? `# ${title}\n\n` : '';
    const images: ImageAttachment[] = [];

    if (Array.isArray(content)) {
        for (const paragraph of content) {
            if (!Array.isArray(paragraph)) continue;

            for (const el of paragraph) {
                const tag = el.tag as string;
                const styles = (el.style as string[]) || [];

                let part = '';
                switch (tag) {
                    case 'text':
                        part = (el.text as string) || '';
                        break;
                    case 'a':
                        part = `[${el.text || el.href}](${el.href})`;
                        break;
                    case 'at':
                        part = `@${el.user_name || el.user_id}`;
                        break;
                    case 'code_block':
                        part = `\n\`\`\`${el.language || ''}\n${el.text || ''}\n\`\`\``;
                        break;
                    case 'img': {
                        const imageKey = (el.image_key as string) || '';
                        if (imageKey) {
                            images.push({ fileKey: imageKey, type: 'image' });
                        }
                        break;
                    }
                }

                // Apply styles
                if (styles.includes('bold')) part = `**${part}**`;
                if (styles.includes('italic')) part = `*${part}*`;
                if (styles.includes('lineThrough')) part = `~~${part}~~`;

                text += part;
            }
            text += '\n';
        }
    }

    return {
        text: text.trim() || '[rich text]',
        images,
    };
}

/**
 * Check if text is a slash command
 */
export function isSlashCommand(text: string): { command: string; args: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
        return { command: trimmed.slice(1), args: '' };
    }

    return {
        command: trimmed.slice(1, spaceIdx),
        args: trimmed.slice(spaceIdx + 1).trim(),
    };
}
