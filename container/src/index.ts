#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import {
  PromptPayload,
  ContainerResult,
  ToolCall,
  ToolEvent,
} from './types.js';
import { createArticleFetcherMcpServer } from './mcp/index.js';

const INPUT_FILE = process.env.INPUT_FILE || '/workspace/input/payload.json';
const OUTPUT_FILE = process.env.OUTPUT_FILE || '/workspace/output/result.json';
const WORKSPACE_DIR = '/workspace/files';

// 创建 MCP 服务器
const articleFetcherMcpServer = createArticleFetcherMcpServer();

interface SDKMessage {
  type: 'user' | 'assistant' | 'result' | 'system';
  message?: { role: string; content: any };
  result?: string;
  subtype?: string;
  session_id?: string;
}

function log(message: string): void {
  console.error(`[miniclaw-agent] ${message}`);
}

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

// Memory system instructions for the agent
const MEMORY_INSTRUCTIONS = `

## Daily Memory System

You have access to a daily memory system to remember important information. Each day has its own memory file.

### Memory Structure
Memory files are organized by date: /workspace/files/memory/YYYY-MM-DD/MEMORY.md

### Today's Memory File
Today's memory file path is provided in your context. You can:
- Read it to see what was learned today
- Append new information using the Write tool (read first, then write with original content + additions)
- Search past memory using Grep on /workspace/files/memory/*/MEMORY.md

### What to Save
Save important information like:
- User preferences or requirements
- Key decisions made during the conversation
- Project progress or milestones
- Action items or follow-ups for tomorrow (use task list format)
- Important facts about the user's work

### Task List Format
For action items or things to remember to do, use the Markdown task list format:
- [ ] Todo item (pending)
- [x] Completed item (done)

### How to Save Memory
1. Read the current day's MEMORY.md
2. Append new information at the end or under appropriate sections
3. Use Write to save the updated content

### Search Past Memory
Use Grep to search across all memory files:
- Pattern: grep -r "keyword" /workspace/files/memory/
`;

async function runAgentWithSDK(
  payload: PromptPayload,
  onStream?: (text: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
): Promise<{
  content: string;
  toolCalls: ToolCall[];
  sdkSessionId?: string;
  sdkResumeAt?: string;
}> {
  const { session, messages, userInput, apiConfig, memory } = payload;

  // 如果有 sdkSessionId，直接使用当前用户输入（SDK会管理历史）
  // 如果没有 sdkSessionId，需要构建完整的 prompt 包含历史
  let fullPrompt = '';
  if (session.sdkSessionId) {
    // 使用 SDK 的 resume 功能，只需要传当前用户输入
    fullPrompt = userInput;
  } else {
    // 新会话，构建完整 prompt：历史消息 + 当前用户输入
    for (const msg of messages) {
      if (msg.role === 'user') {
        fullPrompt += `User: ${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        fullPrompt += `Assistant: ${msg.content}\n\n`;
      }
    }
    fullPrompt += `User: ${userInput}`;
  }

  // 构建增强的系统提示词（包含记忆内容）
  let enhancedSystemPrompt = session.systemPrompt || '';

  // Add memory context if available
  if (memory?.recentContent) {
    enhancedSystemPrompt += `\n\n## Memory Context\n\n${memory.recentContent}\n`;
  }

  // Add memory instructions
  enhancedSystemPrompt += MEMORY_INSTRUCTIONS;

  // 设置环境变量供 SDK 使用
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_API_KEY: apiConfig.apiKey,
  };

  if (apiConfig.baseUrl) {
    sdkEnv.ANTHROPIC_BASE_URL = apiConfig.baseUrl;
  }

  let finalContent = '';
  const toolCalls: ToolCall[] = [];
  let hasStartedStreaming = false;
  let sdkSessionId: string | undefined = session.sdkSessionId;
  let sdkResumeAt: string | undefined;

  // 确保 workspace 目录存在
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  }

  // 使用 Claude Agent SDK
  for await (const message of query({
    prompt: fullPrompt,
    options: {
      cwd: WORKSPACE_DIR,
      resume: session.sdkSessionId,
      resumeSessionAt: session.sdkResumeAt,
      systemPrompt: enhancedSystemPrompt
        ? {
            type: 'preset',
            preset: 'claude_code',
            append: enhancedSystemPrompt,
          }
        : { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'user'],
      allowedTools: [
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'Bash',
        'WebSearch',
        'WebFetch',
        'Skill',
        'TodoWrite',
        'NotebookEdit',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: apiConfig.model,
      mcpServers: {
        'article-fetcher': articleFetcherMcpServer,
      },
    },
  })) {
    const msgType = message.type;
    log(`Received message: type=${msgType}`);

    // if (onStream) {
    //   onStream('=====debug=====' + JSON.stringify(message) + '\n');
    // }

    if (
      message.type === 'system' &&
      message.subtype === 'init' &&
      'session_id' in message
    ) {
      // 捕获新的 SDK session ID
      sdkSessionId = (message as { session_id: string }).session_id;
      log(`Session initialized: ${sdkSessionId}`);
    }

    if (message.type === 'assistant' && 'message' in message) {
      const assistantMsg = message;
      // 捕获 assistant uuid 用于 resumeSessionAt
      if (assistantMsg.uuid) {
        sdkResumeAt = assistantMsg.uuid;
      }
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
            // 记录工具调用
            toolCalls.push(toolCall);
            // 实时发送 tool_use 事件
            if (onToolEvent) {
              onToolEvent({ type: 'tool_use', toolCall });
            }
          }
        }
      }
    } else if (message.type === 'result' && 'result' in message) {
      const resultMsg = message as {
        result?: string;
        subtype?: string;
        tool_call_id?: string;
      };
      if (resultMsg.result !== undefined && resultMsg.tool_call_id) {
        log(`Result for tool ${resultMsg.tool_call_id}: ${resultMsg.subtype}`);
        // 实时发送 tool_result 事件
        if (onToolEvent) {
          onToolEvent({
            type: 'tool_result',
            toolCallId: resultMsg.tool_call_id,
            result: resultMsg.result,
            subtype: resultMsg.subtype,
          });
        }
        // 更新 toolCall 的 result
        const toolCall = toolCalls.find(
          (tc) => tc.id === resultMsg.tool_call_id,
        );
        if (toolCall) {
          toolCall.result = resultMsg.result;
        }
      }
    } else if (message.type === 'user' && 'message' in message) {
      const userMsg = message.message;
      if (Array.isArray(userMsg.content)) {
        for (const block of userMsg.content) {
          if (block.type === 'tool_result' && block.content) {
            // 用户消息（工具结果）
            if (onToolEvent) {
              onToolEvent({
                type: 'tool_result',
                toolCallId: block.tool_use_id,
                result: block.content,
              });
            }
          }
        }
      }
    }
  }

  return { content: finalContent, toolCalls, sdkSessionId, sdkResumeAt };
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
    log(`Received payload for session: ${payload.session.id}`);
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
      sdkSessionId: result.sdkSessionId,
      sdkResumeAt: result.sdkResumeAt,
    };

    writeOutput(output);
  } catch (err: any) {
    log(`Agent error: ${err.message}`);
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
