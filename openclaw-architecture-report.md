# OpenClaw 技术架构参考报告

> 基于 NanoClaw 实现原理分析，指导从零构建个人 AI 助手框架

---

## 目录

1. [项目概述](#1-项目概述)
2. [核心架构原则](#2-核心架构原则)
3. [系统整体架构](#3-系统整体架构)
4. [核心模块详解](#4-核心模块详解)
5. [数据流与通信机制](#5-数据流与通信机制)
6. [安全架构设计](#6-安全架构设计)
7. [扩展机制设计](#7-扩展机制设计)
8. [实现路线图](#8-实现路线图)
9. [关键技术决策](#9-关键技术决策)

---

## 1. 项目概述

### 1.1 什么是 NanoClaw/OpenClaw

**NanoClaw** 是一个轻量级、安全的个人 AI 助手框架，通过即时通讯平台（WhatsApp、Telegram 等）提供 Claude AI 的访问能力。

**设计理念**: "小而美"
- 单进程架构，避免微服务复杂度
- 代码量控制在 ~5,000 行以内
- 容器隔离保障安全
- AI 原生设计（假设用户有 Claude Code 作为协作者）

### 1.2 核心特性

| 特性 | 说明 |
|------|------|
| **单进程架构** | 一个 Node.js 进程处理所有功能 |
| **容器隔离** | AI 代理在 Linux 容器中运行，提供 OS 级隔离 |
| **多平台支持** | WhatsApp、Telegram、Slack、Discord 等 |
| **技能系统** | 通过代码变换动态扩展功能 |
| **组隔离** | 每个聊天组独立的文件系统和会话 |
| **定时任务** | 内置 Cron 风格的任务调度 |

---

## 2. 核心架构原则

### 2.1 极简主义原则

```
❌ 避免:
- 微服务架构
- 过度抽象层
- 复杂的配置系统
- 繁重的文档

✅ 坚持:
- 单进程运行
- 直接的数据库操作
- 显式优于隐式
- 代码即文档
```

### 2.2 安全优先设计

安全不是功能，而是架构的基础:

1. **容器边界** - AI 代理运行在隔离容器中
2. **挂载限制** - 严格的文件系统访问控制
3. **会话隔离** - 每组独立的 AI 会话
4. **凭证保护** - 最小化环境变量暴露

### 2.3 AI 原生设计

假设用户有 Claude Code 作为协作者:
- 简化调试工具（直接阅读代码）
- 减少配置说明（通过技能系统操作）
- 智能错误处理（让 AI 代理理解上下文）

---

## 3. 系统整体架构

### 3.1 架构分层图

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户交互层                                 │
│   WhatsApp    Telegram    Slack    Discord    Web Interface    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        通道适配层 (Channel)                       │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│   │   WhatsApp  │  │   Telegram  │  │    Slack    │            │
│   │   Channel   │  │   Channel   │  │   Channel   │            │
│   └─────────────┘  └─────────────┘  └─────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        核心编排层 (Orchestrator)                  │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│   │  Router  │ │ GroupQueue│ │Scheduler │ │   IPC    │          │
│   │  (路由)   │ │  (队列)   │ │ (调度器) │ │(进程通信)│          │
│   └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        数据存储层                                 │
│   ┌─────────────────┐  ┌─────────────────────────────────────┐ │
│   │   SQLite        │  │           File System               │ │
│   │  (消息/状态)     │  │  (组文件夹 / IPC / 会话 / 日志)      │ │
│   └─────────────────┘  └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        容器执行层                                 │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │                    Docker Container                      │  │
│   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │  │
│   │  │ Claude Agent │  │  MCP Servers │  │  Browser     │  │  │
│   │  │   (SDK)      │  │  (Tools)     │  │  (Puppeteer) │  │  │
│   │  └──────────────┘  └──────────────┘  └──────────────┘  │  │
│   └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 项目目录结构

```
openclaw/
├── src/                          # 核心源代码
│   ├── index.ts                  # 主入口：编排器、状态管理、消息循环
│   ├── config.ts                 # 配置：触发词、路径、轮询间隔
│   ├── types.ts                  # TypeScript 类型定义
│   ├── db.ts                     # SQLite 数据库操作
│   ├── router.ts                 # 消息格式化和出站路由
│   ├── ipc.ts                    # 进程间通信监听器
│   ├── group-queue.ts            # 每组队列和并发控制
│   ├── container-runner.ts       # 生成容器代理
│   ├── container-runtime.ts      # 容器运行时抽象
│   ├── task-scheduler.ts         # 定时任务调度器
│   ├── channels/                 # 通道实现
│   │   └── whatsapp.ts           # WhatsApp 通道
│   ├── group-folder.ts           # 组文件夹路径解析
│   ├── mount-security.ts         # 挂载安全验证
│   └── logger.ts                 # 日志记录
├── container/                    # 容器配置
│   ├── Dockerfile                # 代理容器镜像定义
│   ├── build.sh                  # 容器构建脚本
│   └── agent-runner/             # 容器内运行的代理代码
│       └── src/
│           ├── index.ts          # 代理入口
│           └── ipc-mcp-stdio.ts  # MCP 服务器通信
├── skills-engine/                # 技能系统引擎
│   ├── apply.ts                  # 技能应用逻辑
│   ├── replay.ts                 # 技能重放
│   ├── state.ts                  # 状态管理
│   ├── merge.ts                  # 三路合并
│   └── types.ts                  # 技能类型定义
├── .claude/skills/               # 内置技能包
│   ├── add-telegram/             # 添加 Telegram 支持
│   ├── add-slack/                # 添加 Slack 支持
│   └── ...
├── groups/                       # 组隔离文件夹
│   ├── main/                     # 主组（自聊天，管理员）
│   └── global/                   # 全局只读内存
├── data/                         # 运行时数据
│   ├── db.sqlite                 # SQLite 数据库
│   ├── ipc/                      # IPC 通信目录
│   └── sessions/                 # Claude 会话存储
├── docs/                         # 架构文档
├── package.json
└── tsconfig.json
```

---

## 4. 核心模块详解

### 4.1 编排器 (Orchestrator)

**文件**: `src/index.ts`

编排器是系统的心脏，负责协调所有组件：

```typescript
// 核心职责
interface Orchestrator {
  // 1. 系统启动
  initialize(): Promise<void>;

  // 2. 状态管理
  loadRouterState(): RouterState;
  saveRouterState(state: RouterState): void;

  // 3. 消息循环
  startMessageLoop(): void;

  // 4. 组件协调
  registerChannel(channel: Channel): void;
  scheduleTask(task: ScheduledTask): void;
}
```

**启动流程**:
```
1. 加载配置 (config.ts)
2. 初始化数据库 (db.ts)
3. 加载路由器状态
4. 启动各通道连接
5. 启动 IPC 监听器
6. 启动任务调度器
7. 启动消息轮询循环
```

### 4.2 数据库层 (Database)

**文件**: `src/db.ts`

使用 **better-sqlite3** 同步 SQLite 数据库：

```typescript
// 核心数据表
interface DatabaseSchema {
  // 聊天元数据
  chats: {
    jid: string;           // 聊天唯一标识
    name: string;          // 聊天名称
    last_message_time: number;
  };

  // 消息存储
  messages: {
    id: string;
    chat_jid: string;
    sender_jid: string;
    content: string;
    timestamp: number;
  };

  // 定时任务
  scheduled_tasks: {
    id: string;
    chat_jid: string;
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    next_run: number;
    status: 'active' | 'paused' | 'completed';
  };

  // 路由器状态
  router_state: {
    last_poll_time: number;
    sessions: Record<string, string>;  // group -> sessionId
  };

  // 已注册组
  registered_groups: {
    jid: string;
    folder: string;        // 组隔离文件夹名
    created_at: number;
  };
}
```

**关键操作**:
```typescript
// 获取新消息（轮询）
getNewMessages(jids: string[], since: number): Message[];

// 存储消息
storeMessage(msg: Message): void;

// 获取待执行任务
getDueTasks(): ScheduledTask[];

// 更新任务状态
updateTaskAfterRun(taskId: string, nextRun: number, result: string): void;
```

### 4.3 组队列系统 (Group Queue)

**文件**: `src/group-queue.ts`

**设计目标**:
- 每组独立队列，防止组间阻塞
- 全局并发限制，防止资源耗尽
- 指数退避重试机制

```typescript
class GroupQueue {
  // 每组一个队列
  private queues: Map<string, PQueue>;  // jid -> queue

  // 全局并发限制
  private globalLimit: PQueue;  // 默认并发: 5

  // 关键方法
  async enqueueMessageCheck(jid: string): Promise<void>;
  async enqueueTask(jid: string, taskId: string, fn: () => Promise<void>): Promise<void>;

  // 组处理逻辑
  private async runForGroup(jid: string): Promise<void> {
    // 1. 检查是否已在运行
    // 2. 获取该组所有新消息
    // 3. 构建 prompt
    // 4. 启动容器代理
    // 5. 处理响应
  }
}
```

**并发控制参数**:
```typescript
const CONCURRENCY_CONFIG = {
  maxGlobalContainers: 5,      // 最大并发容器数
  maxRetries: 5,               // 最大重试次数
  baseRetryDelay: 1000,        // 基础重试延迟(ms)
  idleTimeout: 30 * 60 * 1000, // 空闲超时(30分钟)
};
```

### 4.4 容器运行器 (Container Runner)

**文件**: `src/container-runner.ts`

负责生成和管理 AI 代理容器：

```typescript
interface ContainerRunner {
  runContainerAgent(
    group: string,
    options: {
      prompt: string;
      sessionId?: string;
      isScheduledTask?: boolean;
      imageTag?: string;
    }
  ): Promise<ContainerResult>;
}
```

**容器挂载点**:
```
/workspace/group        # 组文件夹（读写）- 组隔离的工作空间
/workspace/project      # 主组项目根（只读）- 共享项目代码
/workspace/global       # 全局内存（只读）- 所有组共享的知识
/workspace/ipc          # IPC 命名空间（读写）- 与主机通信
/home/node/.claude      # Claude 会话（隔离）- 每组独立的 AI 记忆
/app/src                # 代理运行器源码（可定制）
```

**容器启动流程**:
```
1. 获取组文件夹路径
2. 验证挂载安全（allowlist 检查）
3. 构建 Docker 参数
4. 生成临时环境变量文件
5. 启动容器（docker run）
6. 写入 prompt JSON 到 stdin
7. 流式读取 stdout/stderr
8. 等待容器退出
9. 解析结果
```

### 4.5 任务调度器 (Task Scheduler)

**文件**: `src/task-scheduler.ts`

支持 Cron 风格的定时任务：

```typescript
interface ScheduledTask {
  id: string;
  chatJid: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;  // cron 表达式或间隔秒数
  contextMode: 'group' | 'isolated';  // 是否共享组会话
  status: 'active' | 'paused' | 'completed';
  nextRun: number;
  createdAt: number;
}
```

**调度流程**:
```
每分钟执行:
  1. 查询 scheduled_tasks 表中 next_run <= now 且 status = 'active' 的任务
  2. 对每个到期任务:
     a. 通过 GroupQueue 排队执行
     b. 启动容器代理（传入 task prompt）
     c. 捕获输出并记录到 task_run_logs
     d. 计算并更新 next_run
```

### 4.6 IPC 系统 (Inter-Process Communication)

**文件**: `src/ipc.ts`

基于文件系统的进程间通信机制：

```
data/ipc/{group}/
├── messages/           # 容器 -> 主机的消息
│   └── {chatJid}.json
├── tasks/              # 容器创建的任务
│   └── {taskId}.json
└── input/              # 主机 -> 容器的输入
    └── {timestamp}.json
```

**消息格式**:
```typescript
// 容器发送消息
interface IPCMessage {
  type: 'message';
  chatJid: string;
  text: string;
}

// 容器创建任务
interface IPCTask {
  type: 'schedule_task';
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  targetJid?: string;
  contextMode?: 'group' | 'isolated';
}

// 容器暂停任务
interface IPCTaskPause {
  type: 'pause_task';
  taskId: string;
}
```

**IPC 监听器循环**:
```typescript
async function startIpcListener() {
  while (running) {
    // 1. 扫描所有 IPC 目录
    // 2. 处理 messages/ 中的新消息
    // 3. 处理 tasks/ 中的任务操作
    // 4. 清理已处理的文件
    // 5. 等待 POLL_INTERVAL (2秒)
  }
}
```

### 4.7 通道抽象 (Channel Abstraction)

**文件**: `src/types.ts`, `src/channels/whatsapp.ts`

通用通道接口设计：

```typescript
interface Channel {
  name: string;

  // 连接管理
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // 消息操作
  sendMessage(jid: string, text: string): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;

  // JID 所有权检查
  ownsJid(jid: string): boolean;

  // 事件监听
  onMessage?: (msg: IncomingMessage) => void;
}

interface IncomingMessage {
  id: string;
  chatJid: string;
  senderJid: string;
  content: string;
  timestamp: number;
  isFromMe: boolean;
}
```

---

## 5. 数据流与通信机制

### 5.1 消息处理完整流程

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  用户发送消息  │ --> │  WhatsApp    │ --> │  Baileys库   │
└──────────────┘     └──────────────┘     └──────────────┘
                                                   │
                                                   ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   消息循环     │ <-- │    SQLite    │ <-- │  消息处理器   │
│  (2秒轮询)    │     │  (存储消息)   │     │ (WhatsAppCh)│
└──────────────┘     └──────────────┘     └──────────────┘
         │
         ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  GroupQueue  │ --> │  构建 Prompt │ --> │  启动容器    │
│  (排队处理)   │     │ (含历史上下文)│     │ (Docker)    │
└──────────────┘     └──────────────┘     └──────────────┘
                                                   │
                                                   ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  用户收到回复  │ <-- │  WhatsApp    │ <-- │  IPC 文件    │
│              │     │  (Baileys)   │     │ (消息文件)   │
└──────────────┘     └──────────────┘     └──────────────┘
                                                   ^
                                                   │
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Claude API  │ <-- │  Agent SDK   │ <-- │  容器内代理   │
│  (流式响应)   │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
```

### 5.2 Prompt 构建逻辑

```typescript
function buildPrompt(messages: Message[], groupContext: GroupContext): string {
  const parts: string[] = [];

  // 1. 系统提示词
  parts.push(`You are an AI assistant in a group chat.`);
  parts.push(`Group: ${groupContext.name}`);
  parts.push(`You can use tools, access files in /workspace/group/, and schedule tasks.`);

  // 2. 历史消息（最近 N 条）
  parts.push(`\nRecent messages:`);
  for (const msg of messages.slice(-20)) {
    parts.push(`[${msg.timestamp}] ${msg.sender}: ${msg.content}`);
  }

  // 3. 当前待处理消息
  parts.push(`\nNew messages to respond to:`);
  // ...

  return parts.join('\n');
}
```

### 5.3 流式响应处理

```typescript
// 容器内代理 (container/agent-runner/src/index.ts)
const stream = await anthropic.messages.create({
  model: 'claude-sonnet-4-6',
  messages: prompt,
  tools: availableTools,
  stream: true,
});

for await (const chunk of stream) {
  if (chunk.type === 'content_block_delta') {
    // 1. 写入 stdout（主机实时读取）
    process.stdout.write(chunk.delta.text);

    // 2. 如果是完整消息，写入 IPC
    if (isCompleteMessage(chunk)) {
      fs.writeFileSync(
        `/workspace/ipc/messages/${chatJid}.json`,
        JSON.stringify({ type: 'message', chatJid, text: fullMessage })
      );
    }
  }
}
```

---

## 6. 安全架构设计

### 6.1 多层安全防护

```
┌─────────────────────────────────────────────────────────────┐
│  第 1 层: 容器隔离 (主要边界)                                 │
│  - AI 代理在 Docker 容器中运行                                 │
│  - OS 级进程隔离                                              │
│  - 独立的文件系统命名空间                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  第 2 层: 挂载安全                                            │
│  - 外部目录需要显式 allowlist                                 │
│  - 配置文件: ~/.config/openclaw/mount-allowlist.json         │
│  - 禁止挂载敏感路径（/etc, /root 等）                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  第 3 层: 会话隔离                                            │
│  - 每组独立的 Claude 会话 (/home/node/.claude)               │
│  - 会话间不共享上下文                                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  第 4 层: IPC 授权                                            │
│  - 容器只能操作自己组的 IPC 目录                               │
│  - 任务创建验证目标 JID 所有权                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  第 5 层: 凭证过滤                                            │
│  - 仅传递必要的环境变量到容器                                  │
│  - 主机环境变量隔离                                           │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 挂载安全实现

**文件**: `src/mount-security.ts`

```typescript
interface MountAllowlist {
  paths: string[];  // 允许的外部挂载路径
}

function validateMountPath(externalPath: string): boolean {
  // 1. 规范化路径（解析 .. 和 .）
  const normalized = path.normalize(externalPath);

  // 2. 检查是否是绝对路径
  if (!path.isAbsolute(normalized)) {
    return false;
  }

  // 3. 检查是否在 allowlist 中
  const allowlist = loadAllowlist();
  const allowed = allowlist.paths.some(p =>
    normalized === p || normalized.startsWith(p + path.sep)
  );

  // 4. 检查敏感路径
  const forbidden = ['/etc', '/root', '/boot', '/sys', '/proc'];
  if (forbidden.some(f => normalized.startsWith(f))) {
    return false;
  }

  return allowed;
}
```

### 6.3 容器安全配置

**文件**: `container/Dockerfile`

```dockerfile
FROM node:22-slim

# 创建非 root 用户
RUN groupadd -r node && useradd -r -g node -u 1000 node

# 安装依赖
RUN apt-get update && apt-get install -y \
    git \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制并安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制应用代码
COPY --chown=node:node src/ ./src/

# 切换到非 root 用户
USER node

# 运行代理
CMD ["node", "src/index.js"]
```

**安全要点**:
- 使用非 root 用户运行 (`USER node`)
- 最小化基础镜像 (`node:22-slim`)
- 清理包管理器缓存
- 只安装必要的系统依赖

---

## 7. 扩展机制设计

### 7.1 技能系统 (Skills Engine)

技能系统允许通过代码变换动态扩展功能，而无需修改核心代码。

**核心概念**:
```
技能 = 一组代码文件修改 + 结构化数据操作

技能应用 = 三路合并算法 (Three-Way Merge)
基础版本 (base) + 用户修改 (current) + 技能修改 (skill) -> 合并结果
```

**文件结构**:
```
.claude/skills/{skill-name}/
├── skill.yaml              # 技能元数据
├── modify/                 # 代码修改
│   ├── src/
│   │   └── channels/
│   │       └── telegram.ts
│   └── package.json.patch
├── context/                # 上下文说明
│   ├── why.md              # 为什么需要这个技能
│   └── how.md              # 实现原理
└── prompts/                # 安装提示词
    └── apply.txt
```

**技能状态** (`.nanoclaw/state.yaml`):
```yaml
version: 1
applied_skills:
  - name: add-telegram
    applied_at: '2024-01-15T10:30:00Z'
    version: '1.0.0'
  - name: add-gmail
    applied_at: '2024-01-16T14:20:00Z'
    version: '2.1.0'
    mode: tool-only
custom_modifications:
  - file: src/config.ts
    modified_at: '2024-01-17T09:15:00Z'
    hash: 'abc123...'
```

**三路合并算法** (`skills-engine/merge.ts`):

```typescript
async function threeWayMerge(
  base: string,      // 原始版本 (.nanoclaw/base/)
  current: string,    // 用户修改后的版本
  incoming: string    // 技能带来的修改
): Promise<string> {
  // 1. 使用 git merge-file 进行三路合并
  const result = await exec('git', [
    'merge-file',
    '-p',  // 输出到 stdout
    current,
    base,
    incoming
  ]);

  // 2. 如果有冲突，标记冲突位置
  if (result.includes('<<<<<<<')) {
    throw new MergeConflictError(result);
  }

  return result;
}
```

### 7.2 通道扩展

**添加新通道的步骤**:

1. **创建通道文件** (`src/channels/telegram.ts`):
```typescript
import { Channel, IncomingMessage } from '../types';

export class TelegramChannel implements Channel {
  name = 'telegram';
  private bot: Telegraf;

  async connect(): Promise<void> {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
    this.bot.on('message', (ctx) => this.handleMessage(ctx));
    await this.bot.launch();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const [chatId] = jid.split('@');
    await this.bot.telegram.sendMessage(chatId, text);
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@telegram');
  }

  // ...
}
```

2. **注册通道** (通过技能或手动修改 `src/index.ts`):
```typescript
const telegramChannel = new TelegramChannel();
orchestrator.registerChannel(telegramChannel);
```

### 7.3 MCP 工具扩展

MCP (Model Context Protocol) 服务器可以扩展 AI 代理的能力：

```typescript
// container/agent-runner/src/index.ts
const mcpServers: Record<string, MCPServerConfig> = {
  gmail: {
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    env: {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    }
  },
  browser: {
    command: 'npx',
    args: ['-y', '@anthropic-ai/mcp-server-puppeteer'],
  },
  // 添加新的 MCP 服务器...
};
```

---

## 8. 实现路线图

### 阶段 1: 基础框架 (MVP)

**目标**: 实现最小可用的 AI 助手

**任务清单**:
- [ ] 项目初始化和 TypeScript 配置
- [ ] SQLite 数据库设计和实现
- [ ] 基础编排器（启动、消息循环）
- [ ] 简单控制台通道（用于测试）
- [ ] Docker 容器运行器
- [ ] 基础 Claude Agent SDK 集成
- [ ] IPC 文件通信机制

**预计代码量**: ~1,500 行

### 阶段 2: WhatsApp 集成

**目标**: 接入真实消息平台

**任务清单**:
- [ ] 实现 WhatsAppChannel（基于 Baileys）
- [ ] 消息接收和存储
- [ ] 消息发送和格式化
- [ ] 组隔离文件夹系统
- [ ] 基础配置系统
- [ ] 日志记录

**预计代码量**: ~800 行（累计 ~2,300 行）

### 阶段 3: 高级功能

**目标**: 生产环境可用

**任务清单**:
- [ ] 组队列系统和并发控制
- [ ] 任务调度器（Cron 支持）
- [ ] 挂载安全系统
- [ ] 会话持久化
- [ ] 错误处理和重试机制
- [ ] 流式响应支持

**预计代码量**: ~1,200 行（累计 ~3,500 行）

### 阶段 4: 技能系统

**目标**: 支持动态扩展

**任务清单**:
- [ ] 技能引擎核心（apply/replay/state）
- [ ] 三路合并算法
- [ ] 基础技能包（add-telegram, add-slack 等）
- [ ] 技能状态管理
- [ ] 文档和示例

**预计代码量**: ~800 行（累计 ~4,300 行）

### 阶段 5: 优化和扩展

**目标**: 完善和优化

**任务清单**:
- [ ] 性能优化（连接池、缓存）
- [ ] 更多通道（Discord、Slack、Email）
- [ ] MCP 服务器集成
- [ ] Web 管理界面
- [ ] 监控和告警

---

## 9. 关键技术决策

### 9.1 为什么选择 SQLite？

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| **SQLite** | 零配置、单文件、同步 API | 不适合高并发写入 | ✅ 选择 |
| PostgreSQL | 功能丰富、并发性能好 | 需要单独服务、配置复杂 | ❌ 过重 |
| 纯文件存储 | 极简 | 查询困难、无事务 | ❌ 功能不足 |

**理由**: NanoClaw/OpenClaw 是单进程应用，SQLite 的同步 API 简化了代码逻辑，单文件便于备份和迁移。

### 9.2 为什么选择文件系统 IPC？

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| **文件系统** | 简单、可靠、易于调试 | 性能略低 | ✅ 选择 |
| gRPC | 高性能、类型安全 | 增加依赖、复杂性 | ❌ 过重 |
| Unix Socket | 性能好 | 需要额外管理 | ❌ 不必要 |
| 共享内存 | 最高性能 | 复杂性高 | ❌ 过度优化 |

**理由**: 简单可靠优先，性能不是瓶颈（AI 响应耗时远大于 IPC 开销）。

### 9.3 为什么选择 Docker 而非轻量级隔离？

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| **Docker** | 成熟、生态丰富、安全 | 资源占用稍高 | ✅ 选择 |
| Firecracker | 轻量、快速启动 | 需要额外学习、AWS 生态 | ❌ 生态不成熟 |
| gVisor | 更强的安全隔离 | 兼容性、性能开销 | ❌ 过度设计 |
| 无隔离 | 最简单 | 安全风险 | ❌ 不可接受 |

**理由**: Docker 是最成熟和通用的容器方案，开发和部署都很方便。

### 9.4 为什么使用 TypeScript？

- **类型安全**: 在重构时捕获错误
- **AI 友好**: Claude 等 AI 工具对 TypeScript 支持更好
- **生态丰富**: Node.js 有大量的库可用
- **开发效率**: 现代 JavaScript 特性 + 类型系统

---

## 10. 参考资源

### 10.1 相关项目

- **NanoClaw**: 本报告的参考实现
- **Claude Code**: Anthropic 官方 CLI 工具
- **Baileys**: WhatsApp Web API 库
- **Telegraf**: Telegram Bot 框架

### 10.2 关键技术文档

- [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)
- [MCP Protocol](https://modelcontextprotocol.io/)
- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)

---

## 总结

OpenClaw 的架构设计体现了以下核心思想：

1. **简单至上**: 单进程、少依赖、小代码库
2. **安全优先**: 容器隔离而非应用层权限检查
3. **AI 原生**: 充分利用 AI 工具简化开发和运维
4. **可扩展性**: 技能系统允许用户自定义功能
5. **平台无关**: 通道抽象支持多种消息平台

通过这份报告，你应该能够理解 NanoClaw 的实现原理，并具备从零构建自己 AI 助手框架的知识基础。

---

*报告生成时间: 2026-02-27*
*基于 NanoClaw 架构分析*
