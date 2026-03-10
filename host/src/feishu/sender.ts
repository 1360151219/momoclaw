/**
 * Feishu message sender with streaming card support
 * Uses official SDK and CardKit API for interactive cards
 */

import type { Client } from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';
import type { FeishuResponse, FeishuConfig } from './types.js';
import { getHttpClient, toCredentials, type BotCredentials } from './client.js';

const log = logger('feishu:sender');

// Card element IDs for streaming updates
const STREAM_EL = {
  mainMd: 'main_content',
  thinkingPanel: 'thinking_panel',
  thinkingMd: 'thinking_content',
  statsHr: 'stats_hr',
  statsNote: 'stats_note',
} as const;

interface CardBody {
  schema: '2.0';
  config?: {
    streaming_mode?: boolean;
  };
  body: {
    elements: Array<Record<string, unknown>>;
  };
}

export class FeishuSender {
  private client: Client;

  constructor(private config: FeishuConfig) {
    this.client = getHttpClient(toCredentials(config));
  }

  /**
   * Send a simple text card (non-streaming)
   */
  async sendCard(
    chatId: string,
    response: FeishuResponse,
    options?: { replyToMessageId?: string },
  ): Promise<void> {
    const card = this.buildCard(response);
    await this.sendMessage(chatId, card, options);
  }

  /**
   * Send plain text as markdown card
   */
  async sendText(
    chatId: string,
    text: string,
    options?: { replyToMessageId?: string },
  ): Promise<void> {
    const card = this.buildSimpleCard(text);
    await this.sendMessage(chatId, card, options);
  }

  /**
   * Send an error message
   */
  async sendError(
    chatId: string,
    error: string,
    options?: { replyToMessageId?: string },
  ): Promise<void> {
    await this.sendText(chatId, `❌ **Error:** ${error}`, options);
  }

  /**
   * Add reaction emoji to a message
   */
  async addReaction(messageId: string, emoji: string): Promise<string | null> {
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emoji },
        },
      });

      if (res.code !== 0) {
        log.warn(`Failed to add reaction: ${res.msg}`);
        return null;
      }

      return res.data?.reaction_id ?? null;
    } catch (err) {
      log.warn(`Error adding reaction: ${err}`);
      return null;
    }
  }

  /**
   * Remove reaction from a message
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch {
      // Ignore errors
    }
  }

  /**
   * Create a streaming card and return card ID for updates
   */
  async createStreamingCard(): Promise<string> {
    const card = this.buildStreamingCard();
    const res = await this.client.cardkit.v1.card
      .create({
        data: {
          type: 'card_json',
          data: JSON.stringify(card),
        },
      })
      .catch((err) => {
        log.warn(`Failed to create card: ${err}`);
        throw err;
      });

    if (res.code !== 0 || !res.data?.card_id) {
      throw new Error(`Failed to create card: ${res.msg}`);
    }

    return res.data.card_id;
  }

  /**
   * Send a card by reference (after creating it)
   */
  async sendCardByRef(
    chatId: string,
    cardId: string,
    options?: { replyToMessageId?: string },
  ): Promise<void> {
    const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });

    if (options?.replyToMessageId) {
      await this.client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: {
          content,
          msg_type: 'interactive',
        },
      });
    } else {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content,
        },
      });
    }
  }

  /**
   * Update card content via CardKit API
   */
  async updateCard(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    try {
      const res = await this.client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: { content, sequence },
      });
      if (res.code !== 0) {
        log.warn(`Failed to update card element ${elementId}, sequence ${sequence}: ${res.msg}`);
      }
    } catch (err) {
      log.warn(`Failed to update card element ${elementId}, sequence ${sequence}: ${err}`);
    }
  }

  /**
   * Append elements to a card
   */
  async appendCardElements(
    cardId: string,
    elements: Array<Record<string, unknown>>,
    sequence: number,
  ): Promise<void> {
    try {
      const res = await this.client.cardkit.v1.cardElement.create({
        path: { card_id: cardId },
        data: {
          type: 'append',
          elements: JSON.stringify(elements),
          sequence,
        },
      });
      if (res.code !== 0) {
        log.warn(`Failed to append card elements: ${res.msg}`);
      }
    } catch (err) {
      log.warn(`Failed to append card elements: ${err}`);
    }
  }

  /**
   * Insert thinking panel into streaming card
   */
  async insertThinkingPanel(cardId: string, sequence: number): Promise<void> {
    const elements = [
      {
        tag: 'hr',
        element_id: 'thinking_hr',
      },
      {
        tag: 'collapsible_panel',
        element_id: STREAM_EL.thinkingPanel,
        header: {
          title: { tag: 'plain_text', content: '💭 Thinking' },
        },
        expanded: true,
        elements: [
          {
            tag: 'markdown',
            element_id: STREAM_EL.thinkingMd,
            content: '...',
          },
        ],
      },
    ];
    await this.appendCardElements(cardId, elements, sequence);
  }

  /**
   * Remove an element from a card
   */
  async removeCardElement(
    cardId: string,
    elementId: string,
    sequence: number,
  ): Promise<void> {
    try {
      const res = await this.client.cardkit.v1.cardElement.delete({
        path: { card_id: cardId, element_id: elementId },
        data: { sequence },
      });
      if (res.code !== 0) {
        log.warn(`Failed to remove card element ${elementId}: ${res.msg}`);
      }
    } catch (err) {
      log.warn(`Failed to remove card element ${elementId}: ${err}`);
    }
  }

  /**
   * Close streaming mode on a card
   */
  async closeCardStreaming(cardId: string, sequence: number): Promise<void> {
    try {
      const res = await this.client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence,
        },
      });
      if (res.code !== 0) {
        log.warn(`Failed to close card streaming: ${res.msg}`);
      }
    } catch (err) {
      log.warn(`Failed to close card streaming: ${err}`);
    }
  }

  // ── Card Builders ─────────────────────────────────────────

  private buildCard(response: FeishuResponse): CardBody {
    const elements: Array<Record<string, unknown>> = [];

    // Add thinking section if present
    if (response.thinking) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: { tag: 'plain_text', content: '💭 Thinking' },
        },
        elements: [{ tag: 'markdown', content: response.thinking }],
      });
      elements.push({ tag: 'hr' });
    }

    // Main content
    elements.push({ tag: 'markdown', content: response.text });

    // Stats footer
    const stats = this.formatStats(response);
    if (stats) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'markdown', content: `*${stats}*` });
    }

    return {
      schema: '2.0',
      body: { elements },
    };
  }

  private buildSimpleCard(text: string): CardBody {
    return {
      schema: '2.0',
      body: {
        elements: [{ tag: 'markdown', content: text }],
      },
    };
  }

  private buildStreamingCard(): CardBody {
    return {
      schema: '2.0',
      config: {
        streaming_mode: true,
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            element_id: STREAM_EL.mainMd,
            content: '',
          },
          {
            tag: 'collapsible_panel',
            element_id: STREAM_EL.thinkingPanel, // 可直接删除整个面板
            expanded: false,
            header: {
              title: { tag: 'plain_text', content: '💭 Thinking' },
              icon: {
                // ← 箭头图标
                tag: 'standard_icon',
                token: 'down-small-ccm_outlined',
                size: '16px 16px',
              },
              icon_position: 'right', // ← 图标在右侧
              icon_expanded_angle: -180, // ← 展开时旋转180度
            },
            elements: [
              { tag: 'hr' }, // ← 分隔线在里面
              {
                tag: 'markdown',
                element_id: STREAM_EL.thinkingMd,
                content: '_思考中..._',
              },
            ],
          },
        ],
      },
    };
  }

  private formatStats(response: FeishuResponse): string | null {
    const parts: string[] = [];
    if (response.model) parts.push(response.model);
    if (response.elapsedMs)
      parts.push(`${(response.elapsedMs / 1000).toFixed(1)}s`);
    if (response.inputTokens) parts.push(`${response.inputTokens} in`);
    if (response.outputTokens) parts.push(`${response.outputTokens} out`);

    return parts.length > 0 ? parts.join(' · ') : null;
  }

  private async sendMessage(
    chatId: string,
    card: CardBody,
    options?: { replyToMessageId?: string },
  ): Promise<void> {
    const content = JSON.stringify(card);

    if (options?.replyToMessageId) {
      await this.client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: {
          content,
          msg_type: 'interactive',
        },
      });
    } else {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content,
        },
      });
    }
  }
}

// Re-export STREAM_EL for external use
export { STREAM_EL };
