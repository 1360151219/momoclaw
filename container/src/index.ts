#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import {
  query,
  getSessionMessages,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import {
  PromptPayload,
  ContainerResult,
  ToolCall,
  ToolEvent,
} from './types.js';
import { createArticleFetcherMcpServer } from './mcp/article-fetcher/index.js';
import { createBrowserMcpServer } from './mcp/browser/index.js';
import { logger } from './debug.js';
import { INPUT_FILE, OUTPUT_FILE, WORKSPACE_DIR } from './const.js';

// 创建 MCP 服务器
const articleFetcherMcpServer = createArticleFetcherMcpServer();
const browserMcpServer = createBrowserMcpServer();

async function readInput(): Promise<PromptPayload> {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Input file not found: ${INPUT_FILE}`);
  }
  const content = fs.readFileSync(INPUT_FILE, 'utf-8');
  return JSON.parse(content);
}

function writeOutput(output: ContainerResult): void {
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
}

async function runAgentWithSDK(
  payload: PromptPayload,
  onStream?: (text: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
): Promise<{
  content: string;
  toolCalls: ToolCall[];
  compactedSummary?: string;
  claudeSessionId?: string;
}> {
  const { session, userInput, apiConfig, channelContext } = payload;

  // 构建增强的系统提示词
  let enhancedSystemPrompt = session.systemPrompt || '';

  // 设置环境变量供 SDK 使用
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: apiConfig.baseUrl,
    ANTHROPIC_API_KEY: apiConfig.apiKey,
    ANTHROPIC_AUTH_TOKEN: apiConfig.apiKey,
    CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY || '',
  };

  let finalContent = '';
  const toolCalls: ToolCall[] = [];
  let hasStartedStreaming = false;
  let hasCompacted = false;

  // 确保 workspace 目录存在
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  }

  const queryOptions: Options = {
    cwd: WORKSPACE_DIR,
    ...(session.claudeSessionId ? { resume: session.claudeSessionId } : {}),
    systemPrompt: enhancedSystemPrompt
      ? {
          type: 'preset',
          preset: 'claude_code',
          append: enhancedSystemPrompt,
        }
      : { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user'],
    env: sdkEnv,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true, // Bypass all permissions
    model: apiConfig.model,
    stderr: (data: any) => process.stderr.write(data),
    mcpServers: {
      momoclaw_mcp: articleFetcherMcpServer,
      browser_mcp: browserMcpServer,
      ...(process.env.HOST_MCP_URL
        ? {
            host_mcp: {
              type: 'sse' as const,
              url: `${process.env.HOST_MCP_URL}?channelType=${channelContext?.type}&channelId=${channelContext?.channelId}&sessionId=${session.id}`,
            },
          }
        : {}),
      context7: {
        type: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: {
          CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY || '',
        },
      },
      github: {
        type: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN || ''}`,
        },
      },
    },
  };

  let claudeSessionId = session.claudeSessionId;

  logger(`Start query`, userInput);

  // 使用 Claude Agent SDK
  for await (const message of query({
    prompt: userInput,
    options: queryOptions,
  })) {
    logger(`Received message`, message);
    // ============== record step ==============
    // record session id
    if (message.type === 'system' && message.subtype === 'init') {
      claudeSessionId = (message as any).session_id;
    }
    // record compacted summary
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      logger('SDK Context compacted!', message);
      hasCompacted = true;
    }
    // ==============
    if (message.type === 'assistant' && 'message' in message) {
      const assistantMsg = message;
      // 提取文本内容并流式输出
      if (Array.isArray(assistantMsg.message.content)) {
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text' && block.text) {
            const text = block.text;
            finalContent += text;
            if (onStream) {
              if (!hasStartedStreaming) {
                // 第一次输出时，确保有内容
                hasStartedStreaming = true;
              }
              onStream(text);
            }
          } else if (block.type === 'thinking') {
            // 实时发送 thinking 事件
            if (onToolEvent) {
              onToolEvent({ type: 'thinking', content: block.thinking });
            }
          } else if (block.type === 'tool_use') {
            const toolCall: ToolCall = {
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, unknown>,
            };

            // 记录普通工具调用
            toolCalls.push(toolCall);
            // 实时发送 tool_use 事件
            if (onToolEvent) {
              onToolEvent({ type: 'tool_use', toolCall });
            }
          }
        }
      }
    } else if (message.type === 'result' && 'result' in message) {
      // 对话结束
    } else if (message.type === 'user' && 'message' in message) {
      const userMsg = message.message;
      if (Array.isArray(userMsg.content)) {
        for (const block of userMsg.content) {
          if (block.type === 'tool_result' && block.content) {
            // 提取工具结果内容
            let resultText = '';
            if (typeof block.content === 'string') {
              resultText = block.content;
            } else if (Array.isArray(block.content)) {
              resultText = block.content
                .map((b: any) => (b.type === 'text' ? b.text : ''))
                .join('\n');
            }

            // 更新 toolCall 的 result
            const toolCall = toolCalls.find(
              (tc) => tc.id === block.tool_use_id,
            );
            if (toolCall) {
              toolCall.result = resultText;
            }
            // 发送工具结果事件给 Host
            if (onToolEvent && resultText) {
              onToolEvent({
                type: 'tool_result',
                toolCallId: block.tool_use_id,
                result: resultText,
              });
            }
          }
        }
      }
    }
  }

  let compactedSummary: string | undefined;

  if (hasCompacted && claudeSessionId) {
    try {
      const sdkMessages = await getSessionMessages(claudeSessionId);
      // The compact boundary message typically has the summary or we look for the first message
      // Note: According to Claude Agent SDK, compacted messages are often represented as a system message
      const summaryMsg = sdkMessages.find(
        (m: any) =>
          m.type === 'system' && m.message && typeof m.message === 'string',
      );
      if (summaryMsg) {
        compactedSummary = summaryMsg.message as string;
      }
    } catch (err) {
      logger('Failed to get compacted messages', err);
    }
  }

  return {
    content: finalContent,
    toolCalls,
    compactedSummary,
    claudeSessionId,
  };
}

async function main(): Promise<void> {
  // 确保输出目录存在
  const outputDir = path.dirname(OUTPUT_FILE);
  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  } catch (error) {
    logger(`Failed to create output directory`, {
      outputDir: outputDir,
    });
  }

  let payload: PromptPayload;
  try {
    payload = await readInput();
  } catch (err: any) {
    const result: ContainerResult = {
      success: false,
      content: '',
      error: `Failed to read input: ${err.message}`,
    };
    writeOutput(result);
    process.exit(1);
  }

  try {
    // 检查 provider - 目前只支持 Anthropic (Claude Agent SDK)
    if (payload.apiConfig.provider !== 'anthropic') {
      throw new Error(
        'Claude Agent SDK only supports Anthropic provider. Please use anthropic/ model.',
      );
    }

    let contentBuffer = '';
    const result = await runAgentWithSDK(
      payload,
      (chunk) => {
        process.stdout.write(chunk);
        contentBuffer += chunk;
      },
      (toolEvent) => {
        // Send tool events using a special marker protocol
        // Format: __TOOL_EVENT__:{JSON}\n
        process.stdout.write(`\n__TOOL_EVENT__:${JSON.stringify(toolEvent)}\n`);
      },
    );

    const output: ContainerResult = {
      success: true,
      content: contentBuffer || result.content,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      compactedSummary: result.compactedSummary,
      claudeSessionId: result.claudeSessionId,
    };

    writeOutput(output);
    process.exit(0);
  } catch (err: any) {
    const result: ContainerResult = {
      success: false,
      content: '',
      error: err.message || String(err),
    };
    writeOutput(result);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
