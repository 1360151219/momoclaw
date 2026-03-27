export interface Session {
  id: string;
  claudeSessionId?: string;
  name: string;
  systemPrompt: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  isActive: boolean;
  summary?: string;
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
  channelContext?: ChannelContext; // Source channel for result routing
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
  compactedSummary?: string;
  claudeSessionId?: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain?: 'feishu' | 'lark';
  autoReplyGroups?: string[];
}

export interface Config {
  githubToken?: string;
  context7ApiKey?: string;
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
  feishu?: FeishuConfig;
}

export interface MemoryContext {
  todayPath: string;
  recentContent: string;
}

// Stream event types for real-time tool call display
export type ToolEvent =
  | { type: 'tool_use'; toolCall: ToolCall }
  | {
      type: 'tool_result';
      toolCallId: string;
      result: string;
      subtype?: string;
    }
  | { type: 'thinking'; content: string };

// Channel types for cross-channel notifications
export type ChannelType = 'feishu' | 'terminal';

export interface ChannelContext {
  type: ChannelType;
  channelId: string; // feishu: chat_id, terminal: session_id, web: ws_connection_id
}

export interface ChannelHandler {
  readonly type: ChannelType;
  sendMessage(channelId: string, content: string): Promise<void>;
  isAvailable(): boolean;
}

// Scheduled task types
export type ScheduleType = 'cron' | 'interval' | 'once';

export type TaskStatus = 'active' | 'paused' | 'completed' | 'failed';

export interface ScheduledTask {
  id: string;
  sessionId: string;
  prompt: string;
  scheduleType: ScheduleType;
  scheduleValue: string; // cron expression, interval seconds, or timestamp in milliseconds
  status: TaskStatus;
  nextRun: number;
  lastRun?: number;
  lastResult?: string;
  runCount: number;
  createdAt: number;
  updatedAt: number;
  channelType?: ChannelType; // Source channel for result push
  channelId?: string; // Channel-specific ID for routing
}

export interface TaskRunLog {
  id: number;
  taskId: string;
  executedAt: number;
  success: boolean;
  output: string;
  error?: string;
}
