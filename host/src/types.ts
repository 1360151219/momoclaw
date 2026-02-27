export interface Session {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
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

export interface ContainerResult {
  success: boolean;
  content: string;
  toolCalls?: ToolCall[];
  error?: string;
}

export interface Config {
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  defaultModel: string;
  maxTokens: number;
  workspaceDir: string;
  containerTimeout: number;
  dbPath: string;
  defaultSystemPrompt: string;
}
