export interface Session {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  sdkSessionId?: string;
  sdkResumeAt?: string;
  createdAt: number;
  updatedAt: number;
  isActive: boolean;
}

export interface Message {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

export interface PromptPayload {
  session: Session;
  messages: Message[];
  userInput: string;
  apiConfig: ApiConfig;
}

export interface ApiConfig {
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens: number;
}

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface ContainerResult {
  success: boolean;
  content: string;
  toolCalls?: ToolCall[];
  error?: string;
  sdkSessionId?: string;
  sdkResumeAt?: string;
}

// MCP 文章抓取相关类型

export interface Article {
  title: string;
  author?: string;
  content: string;
  url: string;
  publishTime?: string;
  platform: string;
}

export interface ArticleSummary {
  title: string;
  author?: string;
  url: string;
  publishTime?: string;
  platform: string;
  summary: string;
  keyPoints: string[];
  wordCount: number;
  content: string;
}

export type ArticlePlatform =
  | 'zhihu'
  | 'wechat'
  | 'juejin'
  | 'csdn'
  | 'cnblogs'
  | 'bilibili'
  | 'oschina'
  | 'segmentfault'
  | 'generic';
