import dotenv from 'dotenv';
import { Config, ApiConfig } from './types.js';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';

dotenv.config();

function loadMemoryFile(workspaceDir: string, filePath: string): string {
  const fullPath = resolve(workspaceDir, filePath);
  if (existsSync(fullPath)) {
    try {
      return readFileSync(fullPath, 'utf-8').trim();
    } catch (err) {
      console.warn(`Warning: Failed to read ${fullPath}`);
    }
  }
  return '';
}

export function loadConfig(): Config {
  const workspaceDir = resolve(process.env.WORKSPACE_DIR || './workspace');

  // Parse Feishu config from env
  const feishuConfig = process.env.FEISHU_APP_ID
    ? {
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET || '',
        encryptKey: process.env.FEISHU_ENCRYPT_KEY,
        verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
        domain: (process.env.FEISHU_DOMAIN as 'feishu' | 'lark') || 'feishu',
        autoReplyGroups: process.env.FEISHU_AUTO_REPLY_GROUPS
          ? process.env.FEISHU_AUTO_REPLY_GROUPS.split(',').map(s => s.trim())
          : undefined,
      }
    : undefined;

  return {
    githubToken: process.env.GITHUB_TOKEN,
    context7ApiKey: process.env.CONTEXT7_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    defaultModel: process.env.MODEL || 'anthropic/claude-3-5-sonnet-20241022',
    maxTokens: parseInt(process.env.MAX_TOKENS || '4096', 10),
    workspaceDir,
    containerTimeout: parseInt(process.env.CONTAINER_TIMEOUT || '300000', 10),
    dbPath: resolve(process.env.DB_PATH || './data/miniclaw.db'),
    defaultSystemPrompt: process.env.DEFAULT_SYSTEM_PROMPT || '',
    feishu: feishuConfig,
  };
}

export function getApiConfig(
  config: Config,
  modelOverride?: string,
): ApiConfig {
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
