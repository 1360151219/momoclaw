import { createInterface } from 'readline';
import { stdin as input, stdout as output } from 'process';
import kleur from 'kleur';
import { config } from '../config.js';
import {
    getSession,
    getActiveSession,
    createSession,
    clearSessionMessages,
    getSessionMessages,
} from '../db/index.js';
import { processChat } from '../core/chatService.js';
import { ToolEvent } from '../types.js';
import {
    LoadingSpinner,
    displayWelcomeBanner,
    formatPromptPrefix,
    displayError,
    displaySuccess,
    displayToolUseEvent,
    displayToolResultEvent,
    displayThinkingEvent,
} from './ui.js';
import { channelRegistry } from '../cron/sender.js';

export interface ChatOptions {
    sessionId?: string;
}

/**
 * Terminal interactive chat - for CLI usage
 */
export async function startInteractiveChat(
    options: ChatOptions,
): Promise<void> {
    const { sessionId } = options;

    let session = sessionId ? getSession(sessionId) : getActiveSession();

    if (!session) {
        session = createSession('default', 'Default Session');
        console.log(kleur.yellow(`Created default session: ${session.id}`));
    }

    const model = session.model || config.defaultModel;
    const shortModel = model.split('/').pop() || model;

    displayWelcomeBanner(session.id, model);

    channelRegistry.register({
        type: 'terminal',
        sendMessage: async (chatId, content) => {
            console.log(`[terminal cron finished: ${chatId}] ${content}`);
        },
        isAvailable: () => true,
    });

    const rl = createInterface({ input, output });
    let isClosed = false;

    rl.on('close', () => {
        isClosed = true;
    });

    const askQuestion = () => {
        if (isClosed) return;

        const prompt = formatPromptPrefix(session!.id, shortModel);
        rl.question(`${prompt} `, async (userInput) => {
            const trimmed = userInput.trim();

            if (!trimmed) {
                askQuestion();
                return;
            }

            // Built-in commands
            if (trimmed === '/exit' || trimmed === '/quit') {
                console.log(kleur.gray('\nGoodbye! 👋\n'));
                isClosed = true;
                rl.close();
                return;
            }

            if (trimmed === '/clear') {
                clearSessionMessages(session!.id);
                displaySuccess('Session history cleared');
                askQuestion();
                return;
            }

            if (trimmed === '/new') {
                const newSessionId = `session-${Date.now()}`;
                session = createSession(
                    newSessionId,
                    `Session ${new Date().toLocaleString()}`,
                );
                displaySuccess(`New session created: ${session.id}`);
                displayWelcomeBanner(session.id, session.model || config.defaultModel);
                askQuestion();
                return;
            }

            if (trimmed === '/history') {
                const messages = getSessionMessages(session!.id, 1000);
                if (messages.length === 0) {
                    console.log(kleur.gray('No messages in this session.'));
                } else {
                    console.log(
                        kleur.cyan(`\n📜 Session History (${messages.length} messages):\n`),
                    );
                    for (const msg of messages) {
                        const roleColor = msg.role === 'user' ? kleur.blue : kleur.green;
                        const date = new Date(msg.timestamp).toLocaleString();
                        const preview =
                            msg.content.length > 80
                                ? msg.content.slice(0, 80) + '...'
                                : msg.content;
                        console.log(`${roleColor(`[${msg.role}]`)} ${kleur.gray(date)}`);
                        console.log(`  ${preview}\n`);
                    }
                }
                askQuestion();
                return;
            }

            // Process chat using the unified processChat function
            const spinner = new LoadingSpinner('Thinking');
            spinner.start();

            let hasStartedOutput = false;
            let contentBuffer = '';

            const handleToolEvent = (event: ToolEvent) => {
                if (!hasStartedOutput) {
                    spinner.stop();
                    hasStartedOutput = true;
                }

                if (event.type === 'tool_use') {
                    displayToolUseEvent(event.toolCall, hasStartedOutput);
                } else if (event.type === 'tool_result') {
                    displayToolResultEvent(event.toolCallId, event.result, event.subtype);
                } else if (event.type === 'thinking') {
                    displayThinkingEvent(event.content, hasStartedOutput);
                }
            };

            try {
                const result = await processChat({
                    content: trimmed,
                    channelContext: {
                        type: 'terminal',
                        channelId: session?.id || '',
                    },
                    session: session!,
                    onChunk: (chunk) => {
                        if (!hasStartedOutput) {
                            spinner.stop();
                            hasStartedOutput = true;
                            console.log();
                        }
                        process.stdout.write(chunk);
                        contentBuffer += chunk;
                    },
                    onToolEvent: (event) => {
                        // Handle streaming output for CLI
                        if (
                            event.type === 'thinking' ||
                            event.type === 'tool_use' ||
                            event.type === 'tool_result'
                        ) {
                            handleToolEvent(event);
                        }
                    },
                });

                if (!hasStartedOutput) {
                    spinner.stop();
                }

                if (result.success) {
                    if (contentBuffer && !contentBuffer.endsWith('\n')) {
                        console.log();
                    } else if (!contentBuffer && result.content) {
                        console.log();
                        console.log(result.content);
                    }
                    // Note: processChat already saves the assistant message to DB
                } else {
                    displayError(result.error || 'Unknown error');
                }
            } catch (err) {
                spinner.stop();
                displayError(`Error: ${err}`);
            }

            console.log();
            setTimeout(askQuestion, 10);
        });
    };

    askQuestion();
}
