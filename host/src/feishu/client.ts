/**
 * Feishu/Lark SDK client wrapper
 * Thin wrapper around @larksuiteoapi/node-sdk for MomoClaw
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from './types.js';

export type BotCredentials = {
    appId: string;
    appSecret: string;
    domain?: 'feishu' | 'lark' | string;
};

/** Raw Feishu message event from the event dispatcher */
export type RawMessageEvent = {
    sender: {
        sender_id: { open_id?: string; user_id?: string; union_id?: string };
        sender_type?: string;
        tenant_key?: string;
    };
    message: {
        chat_id: string;
        chat_type: 'p2p' | 'group';
        content: string;
        message_id: string;
        message_type: string;
        parent_id?: string;
        root_id?: string;
        thread_id?: string;
        mentions?: Array<{
            key: string;
            id: { open_id?: string; user_id?: string; union_id?: string };
            name: string;
        }>;
    };
};

export type BotInfo = {
    ok: boolean;
    error?: string;
    botOpenId?: string;
    botName?: string;
};

// Cached HTTP client per credentials
let _httpClient: { client: Lark.Client; key: string } | null = null;

function getClientKey(creds: BotCredentials): string {
    return `${creds.appId}:${creds.domain ?? 'feishu'}`;
}

function toLarkDomain(domain: BotCredentials['domain']): Lark.Domain | undefined {
    if (domain === 'lark') return Lark.Domain.Lark;
    if (domain === 'feishu' || !domain) return Lark.Domain.Feishu;
    return undefined;
}

/** Get or create cached HTTP client */
export function getHttpClient(creds: BotCredentials): Lark.Client {
    const key = getClientKey(creds);
    if (_httpClient?.key === key) return _httpClient.client;

    const client = new Lark.Client({
        appId: creds.appId,
        appSecret: creds.appSecret,
        appType: Lark.AppType.SelfBuild,
        domain: toLarkDomain(creds.domain),
    });

    _httpClient = { client, key };
    return client;
}

/** Create new WebSocket client (not cached - one per connection) */
export function getWsClient(creds: BotCredentials): Lark.WSClient {
    if (!creds.appId || !creds.appSecret) {
        throw new Error('Feishu credentials required');
    }
    return new Lark.WSClient({
        appId: creds.appId,
        appSecret: creds.appSecret,
        domain: toLarkDomain(creds.domain),
        loggerLevel: Lark.LoggerLevel.warn,
    });
}

/** Create event dispatcher for message decryption/verification */
export function getEventDispatcher(config: {
    verificationToken?: string;
    encryptKey?: string;
}): Lark.EventDispatcher {
    return new Lark.EventDispatcher({
        verificationToken: config.verificationToken ?? '',
        encryptKey: config.encryptKey ?? '',
    });
}

// Bot info cache
const _botInfoCache = new Map<string, { info: BotInfo; cachedAt: number }>();
const BOT_INFO_TTL_MS = 15 * 60 * 1000;

/** Fetch bot info with caching */
export async function fetchBotInfo(creds: BotCredentials): Promise<BotInfo> {
    if (!creds.appId || !creds.appSecret) {
        return { ok: false, error: 'credentials missing' };
    }

    const key = getClientKey(creds);
    const cached = _botInfoCache.get(key);
    if (cached && Date.now() - cached.cachedAt < BOT_INFO_TTL_MS) {
        return cached.info;
    }

    let info: BotInfo;
    try {
        const client = getHttpClient(creds);
        const res = await client.im.chat.get({ path: { chat_id: '' } }).catch(() => null);

        // Use bot info API directly
        const botRes = await (client as unknown as {
            request: (opts: { method: string; url: string }) => Promise<Record<string, unknown>>;
        }).request({ method: 'GET', url: '/open-apis/bot/v3/info' });

        if (botRes.code !== 0) {
            info = { ok: false, error: `API error ${botRes.code}: ${botRes.msg}` };
        } else {
            const bot = (botRes.bot ?? (botRes.data as Record<string, unknown>)?.bot) as
                | Record<string, unknown>
                | undefined;
            info = {
                ok: true,
                botOpenId: bot?.open_id as string | undefined,
                botName: bot?.bot_name as string | undefined,
            };
        }
    } catch (err) {
        info = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    _botInfoCache.set(key, { info, cachedAt: Date.now() });
    return info;
}

/** Clear all cached clients (for testing) */
export function clearClientCache(): void {
    _httpClient = null;
    _botInfoCache.clear();
}

/** Convert FeishuConfig to BotCredentials */
export function toCredentials(config: FeishuConfig): BotCredentials {
    return {
        appId: config.appId,
        appSecret: config.appSecret,
        domain: config.domain,
    };
}
