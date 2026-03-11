/**
 * Context Compression Module
 *
 * Implements nanobot-style non-destructive compression:
 * - Tracks last_consolidated_index instead of deleting messages
 * - Performs incremental summarization (only new messages)
 * - Provides sliding window fallback for large contexts
 */

import { Message, Session, ApiConfig } from '../types.js';
import { generateSummary, PRESERVE_RECENT_MESSAGES, alignToUserMessage, buildTranscript } from '../summarization.js';

// Configuration
const MIN_MESSAGES_TO_SUMMARIZE = 4; // Minimum messages before summarization makes sense

/**
 * Merge existing summary with new delta summary
 */
async function mergeSummaries(
    existingSummary: string | undefined,
    deltaSummary: string,
    apiConfig: ApiConfig,
): Promise<string> {
    if (!existingSummary) {
        return deltaSummary;
    }

    const prompt = `You have two conversation summaries. Please merge them into a single coherent summary that preserves all important context.

Previous summary:
${existingSummary}

New summary to incorporate:
${deltaSummary}

Please provide a merged summary that:
1. Maintains chronological flow
2. Avoids redundancy
3. Preserves key facts, decisions, and context
4. Keeps the summary concise (max 500 words)

Merged summary:`;

    try {
        const response = await fetch(
            `${apiConfig.baseUrl || 'https://api.anthropic.com'}/v1/messages`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiConfig.apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: apiConfig.model.replace(/^anthropic\//, ''),
                    max_tokens: 1024,
                    messages: [{ role: 'user', content: prompt }],
                }),
            },
        );

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        return data.content?.[0]?.text || `${existingSummary}\n\n${deltaSummary}`;
    } catch {
        // Fallback: simple concatenation
        return `${existingSummary}\n\nSubsequently: ${deltaSummary}`;
    }
}

/**
 * Dependencies needed by the context compressor
 */
export interface CompressorDependencies {
    getMessages: (sessionId: string) => Message[];
    updateSession: (
        sessionId: string,
        updates: { summary?: string; lastConsolidatedIndex?: number },
    ) => void;
    getSession: (sessionId: string) => Session | undefined;
    apiConfig: ApiConfig;
}

/**
 * Compress context for a session
 *
 * Uses nanobot-style non-destructive compression:
 * - Tracks lastConsolidatedIndex instead of deleting messages
 * - Performs incremental summarization (only new messages)
 * - Updates session with new summary and index
 *
 * Call this before sending context to Container to prepare summary
 */
export async function compressContext(
    deps: CompressorDependencies,
    sessionId: string,
): Promise<string | undefined> {
    // Get current session state
    const session = deps.getSession(sessionId);
    if (!session) {
        console.warn(`[ContextCompression] Session ${sessionId} not found`);
        return undefined;
    }

    // Get all messages
    const allMessages = deps.getMessages(sessionId);
    if (allMessages.length < MIN_MESSAGES_TO_SUMMARIZE) {
        return session.summary;
    }

    // Determine which messages to consolidate
    const lastConsolidatedIndex = session.lastConsolidatedIndex ?? -1;
    const unconsolidatedMessages = allMessages.slice(lastConsolidatedIndex + 1);

    // Keep recent messages unconsolidated
    const messagesToSummarize = unconsolidatedMessages.slice(
        0,
        -PRESERVE_RECENT_MESSAGES,
    );

    if (messagesToSummarize.length < MIN_MESSAGES_TO_SUMMARIZE) {
        console.log(
            `[ContextCompression] Too few messages to summarize (${messagesToSummarize.length}), skipping`,
        );
        return session.summary;
    }

    // Align to ensure we start with a user message
    const alignedMessages = alignToUserMessage(messagesToSummarize);

    if (alignedMessages.length < MIN_MESSAGES_TO_SUMMARIZE) {
        return session.summary;
    }

    console.log(
        `[ContextCompression] Summarizing ${alignedMessages.length} messages (preserving last ${PRESERVE_RECENT_MESSAGES})`,
    );

    try {
        // Generate delta summary for new messages only
        const transcript = buildTranscript(alignedMessages);
        const deltaSummary = await generateSummary(
            [{ role: 'user', content: transcript }] as Message[],
            deps.apiConfig,
        );

        // Merge with existing summary
        const combinedSummary = await mergeSummaries(
            session.summary,
            deltaSummary,
            deps.apiConfig,
        );

        // Calculate new consolidated index based on ACTUAL aligned messages
        // alignedMessages[0] is at index lastConsolidatedIndex + 1 + offset from alignment
        const alignmentOffset = messagesToSummarize.length - alignedMessages.length;
        const newLastConsolidatedIndex =
            lastConsolidatedIndex + messagesToSummarize.length - alignmentOffset;

        // Update session with new summary and index (non-destructive!)
        deps.updateSession(sessionId, {
            summary: combinedSummary,
            lastConsolidatedIndex: newLastConsolidatedIndex,
        });

        console.log(
            `[ContextCompression] Consolidated up to index ${newLastConsolidatedIndex}`,
        );

        return combinedSummary;
    } catch (error) {
        console.error('[ContextCompression] Summarization failed:', error);
        return session.summary;
    }
}

/**
 * Get context window for a session
 * Returns messages after lastConsolidatedIndex, with summary prepended
 */
export function getContextWindow(
    session: Session,
    messages: Message[],
    maxMessages: number = 50,
    compressionThreshold: number = 30,
): { summary?: string; messages: Message[]; shouldCompress: boolean } {
    const lastConsolidatedIndex = session.lastConsolidatedIndex ?? -1;

    // Get unconsolidated messages
    let unconsolidated = messages.slice(lastConsolidatedIndex + 1);

    // Check if compression is needed
    const shouldCompress = unconsolidated.length > compressionThreshold;

    // Apply sliding window if still too many messages
    if (unconsolidated.length > maxMessages) {
        unconsolidated = unconsolidated.slice(-maxMessages);
        // Align to user message to avoid orphaned tool results
        unconsolidated = alignToUserMessage(unconsolidated);
    }

    return {
        summary: session.summary,
        messages: unconsolidated,
        shouldCompress,
    };
}
