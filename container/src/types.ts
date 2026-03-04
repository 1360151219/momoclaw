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
  memory?: MemoryContext;
}

export interface MemoryContext {
  todayPath: string;
  recentContent: string;
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

// Stream event types for real-time tool call display
export type ToolEvent =
  | { type: 'tool_use'; toolCall: ToolCall }
  | { type: 'tool_result'; toolCallId: string; result: string; subtype?: string };
