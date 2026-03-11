import { Message, ApiConfig } from './types.js';

// Configuration
export const PRESERVE_RECENT_MESSAGES = 6; // Keep last 6 messages (3 turns) unsummarized

export interface ContextWindow {
    summary?: string;
    messages: Message[];
    totalTokens: number;
}

/**
 * Estimate token count (rough approximation: ~4 chars per token)
 */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Build a conversation transcript from messages
 */
export function buildTranscript(messages: Message[]): string {
    return messages
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
}

/**
 * Generate a summary of conversation history using an LLM call
 * Supports both Anthropic and OpenAI API formats
 */
export async function generateSummary(
    messages: Message[],
    apiConfig: ApiConfig,
    existingSummary?: string
): Promise<string> {
    const transcript = buildTranscript(messages);

    const prompt = `You are a conversation summarization assistant. Your task is to create a concise but comprehensive summary of the following conversation history.

${existingSummary ? `Previous summary:\n${existingSummary}\n\nNew messages to incorporate:\n` : 'Messages to summarize:\n'}${transcript}

Please provide a summary that captures:
1. The main topic(s) discussed
2. Key decisions or conclusions reached
3. Important context that would be needed to continue the conversation
4. Any pending tasks or action items

Keep the summary concise (max 500 words) but informative enough that someone could continue the conversation without losing context.

Summary:`;

    try {
        const isAnthropic = apiConfig.provider === 'anthropic' || apiConfig.model.startsWith('anthropic/');
        const modelName = apiConfig.model.replace(/^(anthropic|openai)\//, '');

        if (isAnthropic) {
            return await callAnthropicAPI(prompt, modelName, apiConfig);
        } else {
            return await callOpenAIAPI(prompt, modelName, apiConfig);
        }
    } catch (error) {
        console.error('Failed to generate summary:', error);
        return createFallbackSummary(messages);
    }
}

/**
 * Call Anthropic API for summarization
 */
async function callAnthropicAPI(
    prompt: string,
    model: string,
    apiConfig: ApiConfig
): Promise<string> {
    const response = await fetch(`${apiConfig.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiConfig.apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
}

/**
 * Call OpenAI API for summarization
 */
async function callOpenAIAPI(
    prompt: string,
    model: string,
    apiConfig: ApiConfig
): Promise<string> {
    const response = await fetch(`${apiConfig.baseUrl || 'https://api.openai.com'}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.apiKey}`,
        },
        body: JSON.stringify({
            model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

/**
 * Create a simple fallback summary when LLM summarization fails
 */
function createFallbackSummary(messages: Message[]): string {
    const topics = new Set<string>();
    const userMessages = messages.filter(m => m.role === 'user');

    // Extract first sentence from each user message as topic hint
    for (const msg of userMessages.slice(0, 5)) {
        const firstSentence = msg.content.split(/[.!?。！？]/)[0].slice(0, 100);
        if (firstSentence.length > 10) {
            topics.add(firstSentence);
        }
    }

    return `Conversation summary (extracted):\n` +
        `- Total exchanges: ${Math.floor(messages.length / 2)}\n` +
        `- Topics: ${Array.from(topics).join('; ').slice(0, 200)}\n` +
        `- Last discussed: ${userMessages[userMessages.length - 1]?.content.slice(0, 100) || 'N/A'}...`;
}

/**
 * Align messages to start with a user message (avoid orphaned tool results)
 * Inspired by nanobot's implementation
 */
export function alignToUserMessage(messages: Message[]): Message[] {
    const firstUserIndex = messages.findIndex(m => m.role === 'user');
    if (firstUserIndex > 0) {
        return messages.slice(firstUserIndex);
    }
    return messages;
}
