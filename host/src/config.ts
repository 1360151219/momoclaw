import dotenv from 'dotenv';
import { Config, ApiConfig } from './types.js';
import { resolve } from 'path';

dotenv.config();

const DEFAULT_SYSTEM_PROMPT = `You are MiniClaw, a helpful AI assistant running in an isolated Docker container.

You have access to the following tools:
- read_file: Read file content from the workspace
- write_file: Write content to a file in the workspace
- edit_file: Replace text in a file
- list_directory: List files in a directory
- execute_command: Execute shell commands in the workspace

Rules:
1. Always use tools to interact with files, never assume file content
2. Be careful with execute_command - it can modify the system
3. When editing files, ensure oldString matches exactly
4. Workspace path is /workspace/files - all file operations are relative to this

Be concise but thorough in your responses.`;

export function loadConfig(): Config {
  const workspaceDir = resolve(process.env.WORKSPACE_DIR || './workspace');

  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    defaultModel: process.env.MODEL || 'anthropic/claude-3-5-sonnet-20241022',
    maxTokens: parseInt(process.env.MAX_TOKENS || '4096', 10),
    workspaceDir,
    containerTimeout: parseInt(process.env.CONTAINER_TIMEOUT || '300000', 10),
    dbPath: resolve(process.env.DB_PATH || './data/miniclaw.db'),
    defaultSystemPrompt: process.env.DEFAULT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
  };
}

export function getApiConfig(config: Config, modelOverride?: string): ApiConfig {
  const modelStr = modelOverride || config.defaultModel;
  const [provider, ...modelParts] = modelStr.split('/');
  const model = modelParts.join('/');
  if (provider === 'anthropic') {
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    return {
      provider: 'anthropic',
      model,
      apiKey: config.anthropicApiKey,
      baseUrl: config.anthropicBaseUrl,
      maxTokens: config.maxTokens,
    };
  }

  if (provider === 'openai') {
    if (!config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }
    return {
      provider: 'openai',
      model,
      apiKey: config.openaiApiKey,
      baseUrl: config.openaiBaseUrl,
      maxTokens: config.maxTokens,
    };
  }

  throw new Error(`Unknown provider: ${provider}. Use 'anthropic' or 'openai'`);
}

export const config = loadConfig();
