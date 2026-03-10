import { createInterface } from 'readline';
import { stdin as input, stdout as output } from 'process';
import kleur from 'kleur';
import { config, getApiConfig } from '../config.js';
import {
  getSession,
  getActiveSession,
  createSession,
  addMessage,
  getSessionMessages,
  updateSessionModel,
  updateSessionPrompt,
  clearSessionMessages,
} from '../db/index.js';
import { runContainerAgent } from '../container.js';
import { PromptPayload, ToolEvent, Session, ToolCall } from '../types.js';
import {
  LoadingSpinner,
  displayWelcomeBanner,
  formatPromptPrefix,
  displayError,
  displaySuccess,
  displayToolUseEvent,
  displayToolResultEvent,
  displayThinkingEvent,
} from '../ui.js';

export interface ChatOptions {
  sessionId?: string;
}

export interface ChatInput {
  content: string;
  session: Session;
}

export interface ChatOutput {
  content: string;
  toolCalls?: ToolCall[];
  success: boolean;
  error?: string;
}

/**
 * Core chat processing logic - platform agnostic
 * Can be used by CLI, Feishu, or other platforms
 */
export async function processChat(input: ChatInput): Promise<ChatOutput> {
  const { content, session } = input;

  // Save user message
  addMessage(session.id, 'user', content);

  // Get history
  const history = getSessionMessages(session.id, 50);

  // Build payload
  const payload: PromptPayload = {
    session: {
      ...session,
      systemPrompt: session.systemPrompt || config.defaultSystemPrompt,
    },
    messages: history.slice(0, -1),
    userInput: content,
    apiConfig: getApiConfig(config, session.model || undefined),
  };

  let contentBuffer = '';

  try {
    const result = await runContainerAgent(
      payload,
      (chunk) => {
        contentBuffer += chunk;
      },
      () => {
        // Tool events handled internally by container
      },
    );

    if (result.success) {
      const finalContent = contentBuffer || result.content;
      addMessage(session.id, 'assistant', finalContent, result.toolCalls);
      return {
        content: finalContent,
        toolCalls: result.toolCalls,
        success: true,
      };
    } else {
      return {
        content: '',
        success: false,
        error: result.error || 'Unknown error',
      };
    }
  } catch (err) {
    return {
      content: '',
      success: false,
      error: `Container error: ${err}`,
    };
  }
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

      // Process chat
      const spinner = new LoadingSpinner('Thinking');
      spinner.start();

      let hasStartedOutput = false;
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
        // Get history
        addMessage(session!.id, 'user', trimmed);
        const history = getSessionMessages(session!.id, 50);

        // Build payload
        const payload: PromptPayload = {
          session: {
            ...session!,
            systemPrompt: session!.systemPrompt || config.defaultSystemPrompt,
          },
          messages: history.slice(0, -1),
          userInput: trimmed,
          apiConfig: getApiConfig(config, session!.model || undefined),
        };

        let contentBuffer = '';
        const result = await runContainerAgent(
          payload,
          (chunk) => {
            if (!hasStartedOutput) {
              spinner.stop();
              hasStartedOutput = true;
              console.log();
            }
            process.stdout.write(chunk);
            contentBuffer += chunk;
          },
          handleToolEvent,
        );

        if (!hasStartedOutput) {
          spinner.stop();
        }

        if (result.success) {
          const finalContent = contentBuffer || result.content;
          if (contentBuffer && !contentBuffer.endsWith('\n')) {
            console.log();
          } else if (!contentBuffer && finalContent) {
            console.log();
            console.log(finalContent);
          }
          addMessage(session!.id, 'assistant', finalContent, result.toolCalls);
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
