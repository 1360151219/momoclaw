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

export interface ApiConfig {
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens: number;
}

// Cron action types for Host-Container communication
export interface CronAction {
  type: 'create' | 'list' | 'pause' | 'resume' | 'delete' | 'logs';
  payload: {
    sessionId: string;
    prompt?: string;
    scheduleType?: 'cron' | 'interval' | 'once';
    scheduleValue?: string;
    taskId?: string;
    limit?: number;
  };
}

export interface ContainerResult {
  success: boolean;
  content: string;
  toolCalls?: ToolCall[];
  error?: string;
  sdkSessionId?: string;
  sdkResumeAt?: string;
  cronActions?: CronAction[];
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

export interface MemoryContext {
  todayPath: string;
  recentContent: string;
}

// Stream event types for real-time tool call display
export type ToolEvent =
  | { type: 'tool_use'; toolCall: ToolCall }
  | { type: 'tool_result'; toolCallId: string; result: string; subtype?: string }
  | { type: 'thinking'; content: string };

// Scheduled task types
export type ScheduleType = 'cron' | 'interval' | 'once';

export type TaskStatus = 'active' | 'paused' | 'completed' | 'failed';

export interface ScheduledTask {
  id: string;
  sessionId: string;
  prompt: string;
  scheduleType: ScheduleType;
  scheduleValue: string;  // cron expression, interval seconds, or timestamp in milliseconds
  status: TaskStatus;
  nextRun: number;
  lastRun?: number;
  lastResult?: string;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRunLog {
  id: number;
  taskId: string;
  executedAt: number;
  success: boolean;
  output: string;
  error?: string;
}

// ========== Outbox Types ==========

export type OutboxMessageType = 'cron' | 'notification' | 'webhook';

export type OutboxMessageStatus = 'pending' | 'processing' | 'sent' | 'failed';

export interface OutboxMessage {
  id: string;
  type: OutboxMessageType;
  status: OutboxMessageStatus;
  payload: unknown;
  createdAt: number;
  retryCount: number;
  lastError?: string;
  sentAt?: number;
}

export interface CronOutboxPayload {
  taskId: string;
  sessionId: string;
  prompt: string;
  executedAt: number;
  success: boolean;
  output: string;
  error?: string;
  toolCalls?: ToolCall[];
}
