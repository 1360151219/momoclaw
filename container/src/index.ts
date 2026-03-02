#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { PromptPayload, ContainerResult, ToolCall } from './types.js';

const INPUT_FILE = process.env.INPUT_FILE || '/workspace/input/payload.json';
const OUTPUT_FILE = process.env.OUTPUT_FILE || '/workspace/output/result.json';
const WORKSPACE_DIR = '/workspace/files';

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

async function runAgentWithSDK(
  payload: PromptPayload,
  onStream?: (text: string) => void,
): Promise<{
  content: string;
  toolCalls: ToolCall[];
  sdkSessionId?: string;
  sdkResumeAt?: string;
}> {
  const { session, messages, userInput, apiConfig } = payload;

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
      systemPrompt: session.systemPrompt
        ? {
            type: 'preset',
            preset: 'claude_code',
            append: session.systemPrompt,
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
    },
  })) {
    const msgType = message.type;
    log(`Received message: type=${msgType}`);

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
      const assistantMsg = message as {
        message: { content: any[] };
        uuid?: string;
      };
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
          } else if (block.type === 'tool_use') {
            // 记录工具调用
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, unknown>,
            });
          }
        }
      }
    } else if (message.type === 'result' && 'result' in message) {
      const resultMsg = message as { result?: string; subtype?: string };
      if (resultMsg.result) {
        // 结果消息也添加到内容中（用于工具结果展示）
        log(`Result: ${resultMsg.subtype}`);
      }
    } else if (message.type === 'user' && 'message' in message) {
      // 用户消息（工具结果）
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
    const result = await runAgentWithSDK(payload, (chunk) => {
      process.stdout.write(chunk);
      contentBuffer += chunk;
    });

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
