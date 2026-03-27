#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  PromptPayload,
  ContainerResult,
  ToolCall,
  ToolEvent,
} from './types.js';
import { createArticleFetcherMcpServer, CRON_TOOLS } from './mcp/index.js';
import { logger } from './debug.js';
import { INPUT_FILE, OUTPUT_FILE, WORKSPACE_DIR } from './const.js';

// 创建 MCP 服务器
const articleFetcherMcpServer = createArticleFetcherMcpServer();

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
}> {
  const { session, messages, userInput, apiConfig, memory } = payload;

  // 构建完整 prompt：历史消息 + 当前用户输入
  let fullPrompt = `## User Context\n- Current Timestamp: ${new Date().getTime()}\n- Session ID: ${session.id}\n- History Messages: \n`;
  for (const msg of messages) {
    if (msg.role === 'user') {
      fullPrompt += `User: ${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      fullPrompt += `Assistant: ${msg.content}\n\n`;
    }
  }
  fullPrompt += `- Current User Input: ${userInput}`;

  // 构建增强的系统提示词（包含记忆内容）
  let enhancedSystemPrompt = session.systemPrompt || '';

  // Add memory context if available (includes summary from Host)
  if (memory?.recentContent) {
    enhancedSystemPrompt += `\n\n## Previous Conversation Summary\n\n${memory.recentContent}\n`;
  }

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

  // 确保 workspace 目录存在
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  }

  if (process.env.DEBUG) {
    const originContent = fs.readFileSync(
      path.join(WORKSPACE_DIR, 'debug-prompt.json'),
      'utf-8',
    );
    const originData = JSON.parse(originContent || '[]');
    fs.writeFileSync(
      path.join(WORKSPACE_DIR, 'debug-prompt.json'),
      JSON.stringify([
        ...originData,
        {
          userPrompt: fullPrompt,
          systemPrompt: enhancedSystemPrompt,
        },
      ]),
    );
  }

  // 使用 Claude Agent SDK
  for await (const message of query({
    prompt: fullPrompt,
    options: {
      cwd: WORKSPACE_DIR,
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
      stderr: (data) => process.stderr.write(data),
      mcpServers: {
        momoclaw_mcp: articleFetcherMcpServer,
        context7: {
          type: 'http',
          url: 'https://mcp.context7.com/mcp',
          headers: {
            CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY || '',
          },
        },
        /**
         * ## 可用工具
          | 工具名 | 作用 | 示例 |
          |--------|------|------|
          | `get_user_info` | 获取 UP 主信息 | 粉丝数、关注数、投稿数、签名等 |
          | `get_video_info` | 获取视频详情 | 标题、UP主、播放量、点赞、投币、简介、时长等 |
          | `search_videos` | 搜索视频 | 按关键词搜索，支持分页 |
         */
        bilibili: {
          command: 'node',
          args: ['/app/node_modules/.bin/bilibili-mcp-server'],
        },
        /**
         * ## GitHub MCP Server
         * 可用工具: search_repositories, get_repository, list_commits, get_file_contents,
         *          create_or_update_file, create_repository, search_code, list_issues,
         *          create_issue, add_issue_comment
         */
        github: {
          command: 'node',
          args: ['/app/node_modules/.bin/mcp-server-github'],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '',
          },
        },
      },
    },
  })) {
    const msgType = message.type;
    logger(`Received message`, message);
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

  return {
    content: finalContent,
    toolCalls,
  };
}

async function main(): Promise<void> {
  // 确保输出目录存在
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let payload: PromptPayload;
  try {
    payload = await readInput();
    logger(`session start，payload received: `, payload);
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
    };

    writeOutput(output);
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
