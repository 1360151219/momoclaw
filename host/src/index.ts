#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import { stdin as input, stdout as output } from 'process';
import kleur from 'kleur';
import { config, getApiConfig } from './config.js';
import {
  initDatabase,
  createSession,
  getSession,
  getActiveSession,
  listSessions,
  switchSession,
  deleteSession,
  updateSessionPrompt,
  updateSessionModel,
  updateSessionSdkState,
  addMessage,
  getSessionMessages,
  clearSessionMessages,
} from './db.js';
import {
  runContainerAgent,
  checkDockerAvailable,
  buildContainerImage,
} from './container.js';
import { PromptPayload, ToolEvent } from './types.js';
import {
  LoadingSpinner,
  displayWelcomeBanner,
  formatPromptPrefix,
  displayToolCall,
  displayError,
  displaySuccess,
  displaySectionHeader,
  displayToolUseEvent,
  displayToolResultEvent,
  displayThinkingEvent,
} from './ui.js';

const program = new Command();

program
  .name('miniclaw')
  .description(
    'MiniClaw AI Assistant - A minimal AI assistant with container isolation',
  )
  .version('1.0.0');

// 全局初始化
async function initialize(): Promise<void> {
  if (!checkDockerAvailable()) {
    console.error(
      kleur.red(
        'Error: Docker is not available. Please install and start Docker first.',
      ),
    );
    process.exit(1);
  }

  initDatabase(config.dbPath);
}

// 格式化会话列表
function formatSessionList(
  sessions: Awaited<ReturnType<typeof listSessions>>,
): string {
  if (sessions.length === 0) {
    return '  No sessions yet. Use "miniclaw new <name>" to create one.';
  }

  return sessions
    .map((s) => {
      const active = s.isActive ? kleur.green('* ') : '  ';
      const model = s.model ? kleur.gray(` [${s.model}]`) : '';
      const date = new Date(s.updatedAt).toLocaleDateString();
      return `${active}${kleur.cyan(s.id)}${model} ${kleur.gray(`(updated: ${date})`)}`;
    })
    .join('\n');
}

// 交互式对话模式
async function interactiveChat(sessionId?: string): Promise<void> {
  let session = sessionId ? getSession(sessionId) : getActiveSession();

  if (!session) {
    // 如果没有活跃会话，尝试创建默认会话
    session = createSession('default', 'Default Session');
    console.log(kleur.yellow(`Created default session: ${session.id}`));
  }

  const model = session.model || config.defaultModel;
  const shortModel = model.split('/').pop() || model;

  // Display welcome banner
  displayWelcomeBanner(session.id, model);

  const rl = createInterface({ input, output });

  let isClosed = false;

  rl.on('close', () => {
    isClosed = true;
  });

  const askQuestion = () => {
    if (isClosed) {
      return;
    }
    const prompt = formatPromptPrefix(session!.id, shortModel);
    rl.question(`${prompt} `, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        askQuestion();
        return;
      }

      // 内置命令
      if (trimmed === '/exit' || trimmed === '/quit') {
        console.log(kleur.gray('\nGoodbye! 👋\n'));
        isClosed = true;
        rl.close();
        return;
      }

      if (trimmed === '/clear') {
        clearSessionMessages(session!.id);
        updateSessionSdkState(session!.id, undefined, undefined);
        displaySuccess('Session history cleared');
        askQuestion();
        return;
      }

      if (trimmed.startsWith('/model ')) {
        const newModel = trimmed.slice(7).trim();
        updateSessionModel(session!.id, newModel);
        session = getSession(session!.id);
        displaySuccess(`Model updated to: ${newModel}`);
        askQuestion();
        return;
      }

      if (trimmed.startsWith('/system ')) {
        const newPrompt = trimmed.slice(8).trim();
        updateSessionPrompt(session!.id, newPrompt);
        session = getSession(session!.id);
        displaySuccess('System prompt updated');
        askQuestion();
        return;
      }

      // 保存用户消息
      addMessage(session!.id, 'user', trimmed);

      // 获取历史消息
      const history = getSessionMessages(session!.id, 50);

      // 构建payload
      const payload: PromptPayload = {
        session: {
          ...session!,
          systemPrompt: session!.systemPrompt || config.defaultSystemPrompt,
        },
        messages: history.slice(0, -1), // 排除刚添加的消息
        userInput: trimmed,
        apiConfig: getApiConfig(config, session!.model || undefined),
      };

      // Start loading spinner
      const spinner = new LoadingSpinner('Thinking');
      spinner.start();

      let contentBuffer = '';
      let hasStartedOutput = false;

      const handleToolEvent = (event: ToolEvent) => {
        // console.log('====debug=====', JSON.stringify(event));
        // Ensure spinner is stopped before displaying tool events
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
        const result = await runContainerAgent(
          payload,
          (chunk) => {
            // Clear spinner on first content
            if (!hasStartedOutput) {
              spinner.stop();
              hasStartedOutput = true;
              // Add a newline before assistant response
              console.log();
            }
            process.stdout.write(chunk);
            contentBuffer += chunk;
          },
          handleToolEvent,
        );

        // If spinner still running, stop it
        if (!hasStartedOutput) {
          spinner.stop();
        }

        if (result.success) {
          const finalContent = contentBuffer || result.content;

          // Ensure output ends with newline
          if (contentBuffer && !contentBuffer.endsWith('\n')) {
            console.log();
          } else if (!contentBuffer && finalContent) {
            console.log();
            console.log(finalContent);
          }

          addMessage(session!.id, 'assistant', finalContent, result.toolCalls);

          // Update SDK session state
          if (result.sdkSessionId || result.sdkResumeAt) {
            updateSessionSdkState(
              session!.id,
              result.sdkSessionId,
              result.sdkResumeAt,
            );
          }
        } else {
          displayError(result.error || 'Unknown error');
        }
      } catch (err) {
        spinner.stop();
        displayError(`Container error: ${err}`);
      }

      // Add a blank line before prompt
      console.log();

      // 延迟显示提示符，确保所有输出完成
      setTimeout(() => {
        askQuestion();
      }, 10);
    });
  };

  askQuestion();
}

// Commands
program
  .command('new <id>')
  .description('Create a new session')
  .option('-n, --name <name>', 'Session display name')
  .option(
    '-m, --model <model>',
    'Model to use (e.g., anthropic/claude-sonnet-4-6)',
  )
  .option('-s, --system <prompt>', 'System prompt')
  .action((id, options) => {
    try {
      const name = options.name || id;
      const session = createSession(
        id,
        name,
        options.system || '',
        options.model,
      );
      console.log(kleur.green(`Created session: ${session.id}`));
      if (session.model) {
        console.log(kleur.gray(`Model: ${session.model}`));
      }
    } catch (err: any) {
      console.error(kleur.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command('list')
  .alias('ls')
  .description('List all sessions')
  .action(() => {
    const sessions = listSessions();
    console.log('\nSessions:');
    console.log(formatSessionList(sessions));
    console.log();
  });

program
  .command('switch <id>')
  .alias('use')
  .description('Switch to a session')
  .action((id) => {
    if (switchSession(id)) {
      console.log(kleur.green(`Switched to session: ${id}`));
    } else {
      console.error(kleur.red(`Session not found: ${id}`));
      process.exit(1);
    }
  });

program
  .command('delete <id>')
  .alias('rm')
  .description('Delete a session')
  .action((id) => {
    if (deleteSession(id)) {
      console.log(kleur.green(`Deleted session: ${id}`));
    } else {
      console.error(kleur.red(`Session not found: ${id}`));
      process.exit(1);
    }
  });

program
  .command('chat [session]')
  .description('Start interactive chat (optionally specify session ID)')
  .action((sessionId) => {
    interactiveChat(sessionId);
  });

program
  .command('build')
  .description('Build the Docker container image')
  .action(async () => {
    console.log(kleur.gray('Building container image...'));
    const success = await buildContainerImage();
    if (success) {
      console.log(kleur.green('Container image built successfully!'));
    } else {
      console.error(kleur.red('Failed to build container image'));
      process.exit(1);
    }
  });

// Default action (interactive chat)
program.action(() => {
  interactiveChat();
});

// Run
initialize()
  .then(() => {
    program.parse();
  })
  .catch((err) => {
    console.error(kleur.red(`Initialization error: ${err}`));
    process.exit(1);
  });
