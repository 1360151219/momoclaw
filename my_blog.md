# 从 0 到 1：实现你自己的 OpenClaw

## 一、引言

最近，OpenClaw 在开发者圈子里非常火。这个开源的 AI Agent 工具以其强大的自动化能力和开放的架构，吸引了大量关注。很多人沉醉于探索 OpenClaw 的使用，探索它到底能做到什么程度。

但笔者想自己去做一个—**理解它的最好方式，就是亲手实现一个**。"干中学"是技术学习的不变真理。想要真正掌握 OpenClaw 的技术原理？那就去实现它。

在 AI 辅助编程的时代，"造轮子"的成本已经大大降低。与其在别人的黑盒里摸索，不如亲手打造自己的工具。这，就是学习新技术的最优解。所有代码都在本地运行，每一行都是自己亲眼看着 AI 写出来的。没有黑盒，没有"这个功能怎么实现的"的困惑，一切都在自己的掌握之中。

---

## 二、OpenClaw 的复刻和解读

### 2.1 OpenClaw 核心功能介绍

OpenClaw 的核心引擎本质上是一个**消息驱动的 agentic loop 运行时**。这是什么意思呢？简单来说：

1. **Agentic Loop（智能体循环）**：AI 不再是"一问一答"就结束了，而是会持续思考、执行、观察结果，直到任务完成。其中 Agent 会通过 Tool、Mcp、Skills 等工具去更好的完成任务。

**核心流程如下：**

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│ 用户输入 │ ──→ │ 理解意图 │ ──→ │ 规划步骤 │ ──→ │ 执行工具 │ ──→ │ 观察结果 │
└─────────┘     └─────────┘     └─────────┘     └─────────┘     └────┬────┘
                                                                     │
                    ┌────────────────────────────────────────────────┘
                    │
                    ▼
            ┌───────────────┐
            │   任务完成？   │
            └───────┬───────┘
                    │
        ┌───────────┴───────────┐
        │                       │
       是                       否
        │                       │
        ▼                       ▼
┌───────────────┐      ┌───────────────┐
│  返回最终结果  │      │  重新规划步骤  │
└───────────────┘      └───────┬───────┘
                               │
                               └────────────────→ (回到"规划步骤")
```

AI 收到任务后，会反复"思考→执行→检查"，直到把事情做完，而不是一次性给出答案就结束了。

2. **会话与记忆** ： 会话与记忆持续落盘，支持长期运行。这也是 OpenClaw 能够自己学习、进化的基础。

3. **主动通信机制** ： 支持在 24 小时内持续运行，甚至还会主动地给你发消息。

### 2.2 24小时运作的诀窍：Cron 和 Heartbeat

OpenClaw 的强大来自于它的**主动通信**机制。不同于传统被动等待指令的 AI Agent 工具，OpenClaw 具备**7x24小时全天候在线**的能力，能够像贴心的真人助理一样主动发起对话。它不再只是"死等 Prompt"，而是拥有了定时扫描环境与系统自检的主动性。这一机制由两大核心组件驱动：Cron（定时任务）和 Heartbeat（心跳检测）。

#### 2.2.1. Cron

Cron 模块赋予了 OpenClaw 时间感知能力，使其能够按照预定的计划执行任务。不同于传统操作系统层面的 crontab，OpenClaw 的 Cron 是**应用层级**的调度器，深度集成了 LLM 的上下文能力。

它支持三种灵活的调度模式：
1. **Cron 表达式模式**：支持标准的 5 位 Cron 语法（如 `0 9 * * *` 表示每天上午 9 点），适用于日报生成、早报推送等周期性任务。
2. **Interval 间隔模式**：基于固定时间间隔的循环执行（如每隔 1 小时检查一次邮件），适用于监控、轮询类任务。
3. **Once 一次性模式**：指定特定的未来时间点执行一次（如明天下午 3 点提醒我开会），任务完成后自动标记为结束。

所有任务数据均持久化存储在 SQLite 数据库中，这意味着即使 OpenClaw 主进程重启，未执行的任务也不会丢失，系统恢复后会自动补执行或继续等待，保证了任务的可靠性。

#### 2.2.2. Heartbeat

如果说 Cron 是 OpenClaw 的日程表，那么 Heartbeat 就是它的**脉搏**。它是 OpenClaw 实现"全天候在线"的底层动力源。

Heartbeat 本质上是一个永不停止的事件循环（Event Loop）：

1. **持续跳动**：Heartbeat 默认以固定的频率（例如每 10 秒或 30 秒）触发一次"心跳"。
2. **状态自检**：每次心跳时，系统会扫描数据库，查找当前时间点是否有已到期（Due）的任务。
3. **唤醒执行**：一旦发现到期任务，Heartbeat 会立即唤醒沉睡的 Agent，加载对应的上下文（Session），并且自行执行任务。
4. **结果反馈**：任务执行完成后，结果会被记录并推送到前端，或者触发新的后续任务。

最妙的是，Heartbeat 任务的记录，是由 OpenClaw 自行决定的。在 OpenClaw 与用户的日常互动中，**用户无需主动触发任何操作**，由 AI 判断一些需要未来提醒的事项，写入数据库中。

正是有了 Heartbeat 机制，OpenClaw 彻底摆脱了"输入-响应"的被动模式。它不需要用户在键盘上敲击任何按键，就能在后台默默工作，真正实现了从"工具"到"智能助手"的质变。

### 2.3. 总结

在 OpenClaw 的设计理念中，我得到了很多有意思的启发，这些都会在我接下来的代码实现中体现：

**一切的一切，能由 AI 自己去做抉择的，不要人工干涉！！！**

1. **文件至上**：OpenClaw 的会话记录、各种 Memory 等均以文件形式存储在本地磁盘。这意味着这是一个**传统 RAG**的系统。所有的文件写入由 Agent 自行决定，所有的检索操作也是由 Agent 通过 Bash Grep 命令来实现的。
2. **灵活的 Skills 系统**：OpenClaw 的 Skills 系统是其最核心的功能模块。

---
---

## 三、核心组件

OpenClaw 采用经典的分层架构，由三个层次构成：

### 3.1 Frontend（表现层）

负责与用户直接交互。主要功能：

- 渲染聊天界面，接收用户输入
- 展示 AI 回复的流式输出
- 显示任务执行状态（进度条、日志输出）
- 提供配置面板（API Key、模型选择、参数调整）

技术实现上，Frontend 是一个独立的 Electron/React 应用，通过 WebSocket 与 Backend 保持长连接，实现实时双向通信。

### 3.2 Backend（业务逻辑层）

系统的核心，处理所有业务逻辑：

- **Agent 编排**：管理 LLM 调用链，决定何时推理、何时调用工具
- **MCP 客户端**：与外部工具服务器建立连接，执行工具调用
- **任务调度**：维护任务队列，处理并发和优先级
- **Docker 管理**：创建、监控、销毁隔离的执行环境
- **会话状态**：管理对话历史、上下文窗口、持久化存储

Backend 本身又分为两层：HTTP API 层（对外暴露接口）和 Core 层（核心业务逻辑）。

### 3.3 Communication（通信层）

连接 Frontend 和 Backend 的桥梁，同时处理外部通信：

- **内部通信**：Frontend ↔ Backend 的实时消息传递（基于 WebSocket）
- **MCP 传输**：与外部 MCP 服务器的连接管理（stdio 或 HTTP）
- **协议适配**：将 AIEOS 格式的消息转换为内部数据结构
- **流式处理**：支持 SSE（Server-Sent Events）式的增量数据推送

### 3.4 三层交互流程

1. 用户在 Frontend 输入消息
2. Frontend 通过 WebSocket 发送 AIEOS 格式的请求到 Backend
3. Backend 解析请求，调用 LLM 进行推理
4. 如需工具执行，Backend 通过 MCP 调用外部服务器
5. Backend 将生成内容实时流式推送到 Frontend
6. Frontend 逐字渲染，展示最终结果

这种分层设计让各层职责清晰：Frontend 专注交互体验，Backend 专注业务逻辑，Communication 专注可靠传输。任何一层都可以独立替换或升级，不影响其他层。

---

## 四、技术实现

这一节是"干中学"的核心。下面这些代码示例不是给你"看看而已"的——它们就是 OpenClaw 的真实实现。当你动手写这些代码时，你会逐行理解每个组件为什么存在、如何工作。

就像看着 AI 把积木一块块搭起来，你不只是拿到了成品，更理解了建筑结构。遇到不懂的地方？打个断点。想看看数据怎么流动？加一行日志。觉得某个行为不合理？直接改源码。

**所有这些代码都在你的本地运行。** 你拥有完全的控制权。没有黑盒，没有"魔法"。每个功能你都可以亲手调试、亲手改。这才是"干中学"的真正含义——不是读文档，而是亲手实现、亲手折腾、亲手搞懂。

### 4.1 Docker 容器隔离

#### 为什么需要隔离？

AI Agent 会执行代码、读写文件、调用系统命令。如果让它直接在你的主系统上运行，一个错误的命令可能删掉重要文件，一个恶意指令可能窃取数据。隔离不是可选项，是必选项。

#### 实现方式

OpenClaw 为每个任务创建独立的 Docker 容器：

- 容器镜像基于 Alpine Linux，体积小巧（约 5MB）
- 每个会话分配一个独立容器，任务结束即销毁
- 通过 Volume 挂载，只允许访问指定的"工作目录"
- 网络默认隔离，需要外网访问时才开启有限权限

代码层面，Backend 通过 Dockerode（Node.js 的 Docker SDK）管理容器生命周期：

```typescript
// 伪代码示例
const container = await docker.createContainer({
  Image: 'momoclaw-runtime',
  Cmd: ['node', 'execute.js'],
  HostConfig: {
    Binds: ['/safe/workspace:/workspace:rw'],
    NetworkMode: 'none', // 默认断网
  }
});
```

#### 安全优势

- **资源限制**：CPU、内存有上限，防止死循环拖垮系统
- **文件沙箱**：只能读写挂载的目录，看不到系统其他文件
- **网络管控**：默认无网络，需要时白名单控制
- **用完即焚**：容器销毁后不留痕迹，敏感数据不残留

### 4.2 SQLite 持久化存储

#### 为什么选 SQLite？

OpenClaw 需要保存会话历史、任务记录、用户配置。SQLite 是最佳选择：零配置、单文件、足够快、无需独立服务。

#### 数据模型

核心表结构很简单：

```sql
-- 会话表
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER,
  updated_at INTEGER,
  metadata TEXT -- JSON 格式存储额外信息
);

-- 消息表
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  role TEXT, -- 'user' | 'assistant' | 'system'
  content TEXT,
  timestamp INTEGER
);

-- 任务表
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  status TEXT, -- 'pending' | 'running' | 'completed' | 'failed'
  type TEXT,   -- 任务类型标识
  result TEXT, -- 执行结果（JSON）
  created_at INTEGER
);
```

#### 读写操作

Backend 使用 better-sqlite3 库，采用同步 API（SQLite 是嵌入式数据库，同步调用足够快且代码更简单）：

```typescript
// 插入消息
const stmt = db.prepare(
  'INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)'
);
stmt.run(generateId(), sessionId, role, content);
```

### 4.3 Claude Agent SDK 的使用

#### SDK 集成

OpenClaw 基于 Anthropic 的 Claude Agent SDK（@anthropic-ai/sdk）构建。这个 SDK 提供了与 Claude 模型交互的完整能力。

#### 核心 API 调用

最基础的调用是这样：

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const response = await anthropic.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 4096,
  messages: [{ role: 'user', content: '你好' }],
});
```

#### 工具调用（Function Calling）

Agent 的核心能力是让 LLM 调用工具。Claude SDK 通过 `tools` 参数实现：

```typescript
const response = await anthropic.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 4096,
  messages: conversationHistory,
  tools: [
    {
      name: 'read_file',
      description: '读取文件内容',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' }
        },
        required: ['path']
      }
    }
  ],
});

// 如果 Claude 决定调用工具，response.stop_reason 会是 'tool_use'
if (response.stop_reason === 'tool_use') {
  const toolCall = response.content.find(c => c.type === 'tool_use');
  // 执行工具，把结果再传回给 Claude
}
```

#### 流式输出

为了让用户实时看到生成内容，使用 `stream` 模式：

```typescript
const stream = anthropic.messages.create({
  ...params,
  stream: true,
});

for await (const chunk of stream) {
  if (chunk.type === 'content_block_delta') {
    // 实时推送到 Frontend
    websocket.send(chunk.delta.text);
  }
}
```

这就是 OpenClaw 的技术三支柱：**Docker 保安全，SQLite 管数据，Claude SDK 提供智能**。

---

## 五、架构设计

### 5.1 核心架构图

先看整体架构：

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Chat UI     │  │  Task Panel  │  │  Config View │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└────────────────────┬────────────────────────────────────────┘
                     │ WebSocket (AIEOS)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                        Backend                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              HTTP API Layer                          │  │
│  │  (接收 Frontend 请求，返回流式响应)                   │  │
│  └────────────────────┬─────────────────────────────────┘  │
│                       ▼                                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Core Layer                              │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐     │  │
│  │  │   Agent    │  │   Task     │  │  Session   │     │  │
│  │  │  Engine    │  │  Scheduler │  │  Manager   │     │  │
│  │  └────────────┘  └────────────┘  └────────────┘     │  │
│  └────────────────────┬─────────────────────────────────┘  │
└───────────────────────┼────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   SQLite     │ │   Docker     │ │  MCP Servers │
│  (Storage)   │ │ (Execution)  │ │   (Tools)    │
└──────────────┘ └──────────────┘ └──────────────┘
```

这个架构的核心思想是**关注点分离**：Frontend 只管展示，Backend 只管逻辑，存储、执行、工具都是可插拔的外部服务。

### 5.2 通信机制（AIEOS 协议详解）

还记得第 2 节提到的 AIEOS 协议吗？现在我们来解剖它。

AIEOS（AI Execution and Orchestration Schema）是 OpenClaw 自定义的通信协议，基于 JSON-RPC 风格设计。它定义了三个核心概念：**任务（Task）**、**消息（Message）**、**事件（Event）**。

#### 任务（Task）

一个 Task 代表一次完整的 AI 交互流程，从用户输入到最终输出。Task 的结构：

```json
{
  "id": "task_001",
  "type": "chat",
  "status": "running",
  "session_id": "sess_123",
  "payload": {
    "message": "帮我写一个冒泡排序"
  },
  "created_at": 1709542800000
}
```

#### 消息（Message）

Message 是 Task 内部的通信单元，代表 Agent 与用户的每一次信息交换：

```json
{
  "id": "msg_001",
  "task_id": "task_001",
  "role": "assistant",
  "content": "我来帮你写冒泡排序...",
  "tool_calls": null,
  "timestamp": 1709542805000
}
```

#### 事件（Event）

Event 用于实时推送状态变更，让 Frontend 能够展示进度：

```json
{
  "type": "task.progress",
  "task_id": "task_001",
  "data": {
    "step": "generating",
    "progress": 60
  },
  "timestamp": 1709542808000
}
```

#### 通信流程示例

**1. Frontend → Backend：创建 Task**

```json
{
  "method": "task.create",
  "params": {
    "session_id": "sess_123",
    "message": "帮我写一个冒泡排序"
  }
}
```

**2. Backend → Frontend：流式返回（多个 Event）**

```json
// Event 1: 开始处理
{ "type": "task.started", "task_id": "task_001" }

// Event 2: 正在思考
{ "type": "llm.thinking", "content": "用户想要一个..." }

// Event 3: 调用工具（如果需要）
{ "type": "tool.called", "tool": "write_file", "args": { "path": "sort.js" } }

// Event 4: 输出内容（流式）
{ "type": "content.delta", "delta": "function bubbleSort..." }

// Event 5: 完成
{ "type": "task.completed", "task_id": "task_001" }
```

#### 与 MCP 的关系

前面说过 MCP 和 AIEOS 都是 JSON-RPC 风格，这里补充它们的联系：

- AIEOS 处理**内部通信**（Frontend ↔ Backend）
- MCP 处理**外部工具通信**（Backend ↔ Tool Servers）
- 两者都采用请求-响应模式，可以共享底层的传输层代码

### 5.3 安全策略

OpenClaw 的安全设计遵循"最小权限原则"：

#### 容器隔离

- 每个任务在独立容器中运行
- 容器无网络访问（除非显式开启）
- 容器只能访问挂载的工作目录

#### 工具权限控制

- 危险操作（如 `rm -rf /`）需要用户确认
- 文件访问只能在工作目录内
- 敏感环境变量不会传入容器

#### API 安全

- API Key 存储在本地，不会上传到任何服务器
- WebSocket 连接本地-only，不对外暴露
- 所有外部请求都经过代理，防止信息泄露

#### 审计日志

- 所有执行的操作都记录到 SQLite
- 可以回溯查看历史任务的具体行为
- 方便排查问题或发现异常

这套安全机制保证了即使 AI 产生了恶意指令或用户输入了危险命令，损失也能被控制在最小范围。

---

## 六、关键实现细节

### 6.1 任务管理

任务管理是 OpenClaw 的核心。一个任务从创建到完成，经历完整的生命周期。

#### 任务状态机

```
pending → running → [completed | failed]
            ↓
        paused (可恢复)
```

#### 任务队列设计

使用简单的内存队列 + SQLite 持久化：

```typescript
class TaskManager {
  private queue: Task[] = [];
  private running: Map<string, Task> = new Map();

  async enqueue(task: Task): Promise<void> {
    // 先存数据库，保证不丢失
    await db.prepare('INSERT INTO tasks (...)').run(...);

    // 加入内存队列
    this.queue.push(task);

    // 触发调度
    this.schedule();
  }

  private async schedule(): Promise<void> {
    // 控制并发数，默认同时只跑 3 个任务
    while (this.running.size < 3 && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running.set(task.id, task);
      this.execute(task);
    }
  }

  private async execute(task: Task): Promise<void> {
    try {
      await this.updateStatus(task.id, 'running');
      // 实际执行逻辑...
      await this.updateStatus(task.id, 'completed');
    } catch (error) {
      await this.updateStatus(task.id, 'failed');
    } finally {
      this.running.delete(task.id);
      this.schedule(); // 触发下一个
    }
  }
}
```

#### 任务取消

用户可能中途想取消任务。实现方式是保存 AbortController：

```typescript
private abortControllers: Map<string, AbortController> = new Map();

async cancel(taskId: string): Promise<void> {
  const controller = this.abortControllers.get(taskId);
  if (controller) {
    controller.abort();
  }
}
```

### 6.2 会话状态管理

会话（Session）是一组相关任务的容器，包含对话历史和共享上下文。

#### 上下文窗口管理

Claude 有上下文长度限制（如 200K tokens）。当对话变长时，需要策略性地裁剪：

```typescript
class SessionManager {
  async getContext(sessionId: string, maxTokens: number = 100000): Promise<Message[]> {
    const messages = await this.loadMessages(sessionId);

    // 简单策略：保留系统提示 + 最近 N 条
    const systemMessage = messages.find(m => m.role === 'system');
    const recentMessages = messages.slice(-20);

    return systemMessage
      ? [systemMessage, ...recentMessages]
      : recentMessages;
  }
}
```

**更聪明的策略（可选实现）：**

- 对早期消息进行摘要，保留关键信息
- 优先保留用户明确标记为重要的消息
- 根据 token 数动态调整保留数量

#### 会话持久化

会话数据自动保存到 SQLite，即使程序崩溃也能恢复：

```typescript
// 自动保存触发点
- 每条新消息到达时
- 任务状态变更时
- 用户手动触发保存时
```

### 6.3 资源监控

监控 Docker 容器的资源使用，防止某个任务拖垮系统。

#### 容器资源限制

创建容器时设置硬性限制：

```typescript
const container = await docker.createContainer({
  HostConfig: {
    Memory: 512 * 1024 * 1024,  // 512MB 内存限制
    CpuQuota: 100000,            // 限制 CPU 使用
  }
});
```

#### 实时监控

使用 Docker Stats API 获取容器实时资源使用：

```typescript
async monitorContainer(containerId: string): Promise<void> {
  const stats = await docker.getContainer(containerId).stats({ stream: false });

  const memoryUsage = stats.memory_stats.usage;
  const cpuUsage = this.calculateCPUPercent(stats);

  // 如果超过阈值，发送警告或强制停止
  if (memoryUsage > MEMORY_THRESHOLD) {
    await this.handleResourceExhaustion(containerId);
  }
}
```

#### 优雅降级

当资源紧张时，系统可以：

- 暂停新任务的调度
- 提示用户有长时间运行的任务
- 自动清理已完成任务的容器

这三个机制（任务管理、会话状态、资源监控）构成了 OpenClaw 的稳定基石。理解它们的实现，你就掌握了 Agent 系统的核心工程实践。

---

## 七、实际使用示例

### 7.1 配置文件说明

OpenClaw 使用 YAML 作为配置文件，默认位于 `~/.config/openclaw/config.yaml`。

#### 最小可用配置

```yaml
# 大模型配置
llm:
  provider: anthropic
  api_key: ${ANTHROPIC_API_KEY}  # 从环境变量读取
  model: claude-3-5-sonnet-20241022
  max_tokens: 4096

# 服务器配置
server:
  port: 3000
  host: localhost

# Docker 配置
docker:
  enabled: true
  image: momoclaw-runtime
  memory_limit: 512m
  cpu_limit: 1.0

# MCP 工具配置
mcp:
  servers:
    - name: filesystem
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    - name: fetch
      command: uvx
      args: ["mcp-server-fetch"]

# 日志配置
logging:
  level: info
  file: ~/.config/openclaw/log.txt
```

#### 配置项说明

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `llm.provider` | 模型提供商 | anthropic |
| `llm.model` | 模型名称 | claude-3-5-sonnet |
| `docker.enabled` | 是否启用容器隔离 | true |
| `docker.memory_limit` | 容器内存限制 | 512m |
| `mcp.servers` | MCP 工具服务器列表 | [] |

### 7.2 任务调度示例

下面是一个完整的多步骤任务执行示例——让 OpenClaw 帮你创建一个简单的 Web 项目。

**用户输入：**

> "帮我创建一个简单的 TODO 应用，用纯 HTML/JS/CSS，保存在 /workspace/todo 目录"

**OpenClaw 的执行流程：**

**1. 分析意图**

- 识别任务：创建文件、编写代码
- 确定步骤：创建目录 → 创建 HTML → 创建 CSS → 创建 JS

**2. 创建目录**

```json
{
  "type": "tool.called",
  "tool": "execute_command",
  "args": { "command": "mkdir -p /workspace/todo" }
}
```

**3. 生成代码**

- 调用 Claude 生成 HTML 结构
- 调用 Claude 生成 CSS 样式
- 调用 Claude 生成 JS 逻辑

**4. 写入文件**

```json
{
  "type": "tool.called",
  "tool": "write_file",
  "args": {
    "path": "/workspace/todo/index.html",
    "content": "<!DOCTYPE html>..."
  }
}
```

**5. 验证结果**

- 读取生成的文件确认写入成功
- 向用户展示文件列表和代码预览

**Frontend 实时看到的：**

```
[系统] 正在分析任务...
[系统] 正在创建目录...
[系统] 正在生成代码...
[Claude] 我来帮你创建 TODO 应用。首先创建项目结构...
[工具] 执行: mkdir -p /workspace/todo
[工具] 写入: /workspace/todo/index.html (2.3KB)
[工具] 写入: /workspace/todo/style.css (1.8KB)
[工具] 写入: /workspace/todo/app.js (3.1KB)
[Claude] 已完成！项目结构如下：
         /workspace/todo/
         ├── index.html
         ├── style.css
         └── app.js
```

### 7.3 插件系统介绍

OpenClaw 的插件系统基于 MCP 协议，让扩展变得简单。

#### 什么是插件？

插件 = 符合 MCP 协议的工具服务器。它可以是用任何语言编写的独立进程，只要实现了 MCP 标准接口，OpenClaw 就能调用它。

#### 使用现有插件

社区已经有很多现成的 MCP 服务器，可以直接使用：

```yaml
mcp:
  servers:
    # 文件系统访问
    - name: fs
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]

    # SQLite 数据库
    - name: sqlite
      command: uvx
      args: ["mcp-server-sqlite", "/path/to/db.sqlite"]

    # Git 操作
    - name: git
      command: uvx
      args: ["mcp-server-git"]

    # 网页获取
    - name: fetch
      command: uvx
      args: ["mcp-server-fetch"]
```

#### 插件工作原理

1. OpenClaw 启动时，根据配置启动各个 MCP 服务器进程
2. 通过 stdio 或 HTTP 与服务器建立连接
3. 调用 `tools/list` 获取该服务器提供的工具列表
4. 将这些工具注册到 Agent 的工具箱中
5. 当 Agent 需要时，通过 `tools/call` 调用具体工具

这种设计让 OpenClaw 的能力可以无限扩展——需要新功能？找个 MCP 服务器，或者自己写一个。

---

## 八、扩展指南

### 8.1 开发自己的工具

如果现有的 MCP 服务器不能满足需求，你可以自己写一个。

**最简单的 MCP 服务器（Node.js）：**

```typescript
// calculator.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({
  name: 'calculator',
  version: '1.0.0',
}, {
  capabilities: {
    tools: {}
  }
});

// 定义工具
server.setRequestHandler('tools/list', async () => {
  return {
    tools: [{
      name: 'calculate',
      description: '执行数学计算',
      inputSchema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '数学表达式，如 "1 + 2 * 3"'
          }
        },
        required: ['expression']
      }
    }]
  };
});

// 处理工具调用
server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name === 'calculate') {
    const { expression } = request.params.arguments;
    try {
      // 注意：实际生产环境不要用 eval！这里只是示例
      const result = eval(expression);
      return {
        content: [{ type: 'text', text: String(result) }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: '计算错误' }]
      };
    }
  }
  throw new Error('未知工具');
});

// 启动服务器
const transport = new StdioServerTransport();
await server.connect(transport);
```

把这个文件加到配置文件里，OpenClaw 就能调用 `calculate` 工具了。

### 8.2 自定义 LLM 配置

OpenClaw 默认使用 Claude，但你可以换成其他模型。

**使用 OpenAI：**

```yaml
llm:
  provider: openai
  api_key: ${OPENAI_API_KEY}
  model: gpt-4o
  base_url: https://api.openai.com/v1  # 可选，用于代理
```

**使用本地模型（Ollama）：**

```yaml
llm:
  provider: ollama
  base_url: http://localhost:11434
  model: llama3.2
```

**温度参数调整：**

```yaml
llm:
  temperature: 0.7  # 0-2，越低越确定，越高越创意
  top_p: 0.9        # 核采样参数
```

### 8.3 最佳实践

经过前面的学习，这里总结一些实用建议：

#### 安全第一

- 永远开启 Docker 隔离
- 敏感操作（删除、修改系统文件）加确认提示
- API Key 存环境变量，不要硬编码

#### 提示工程

- 在配置文件里设置系统提示词，定义 Agent 的行为风格
- 复杂任务拆解成多个小任务，逐步执行
- 让 Agent 在执行危险操作前"说出"它要做什么

#### 调试技巧

- 开启 debug 日志级别，查看完整通信过程
- 使用 `task.list` 和 `task.get` API 查看任务状态
- 在 SQLite 里直接查数据，验证持久化是否正常

#### 性能优化

- 合理设置上下文长度，避免 Token 浪费
- 对频繁使用的工具设置缓存
- 长时间运行的任务考虑异步执行 + 回调通知

#### 扩展原则

- 优先找现成的 MCP 服务器，避免重复造轮子
- 自己写工具时保持单一职责，一个工具只做一件事
- 工具的描述要清晰，这会影响 LLM 的调用决策

掌握这些，你就从"会用 OpenClaw"进阶到"精通 OpenClaw"了。

---

## 九、总结

### 9.1 回顾要点

通过这篇文章，我们从零开始解剖了 OpenClaw 的技术架构：

1. **理解了核心概念**：OpenClaw 是一个桌面 AI 助手，通过 MCP 接入外部工具，通过 AIEOS 实现内部通信
2. **掌握了技术栈**：Docker 保安全、SQLite 管数据、Claude SDK 提供智能
3. **看清了架构设计**：Frontend 负责交互，Backend 处理逻辑，Communication 连接两者
4. **深入了关键机制**：任务管理、会话状态、资源监控，构成稳定运行的基石
5. **学会了扩展定制**：开发工具、切换模型、遵循最佳实践

最重要的是，你理解了**干中学**的真谛——不是读文档，而是亲手实现、亲手调试、亲手掌握。

### 9.2 未来展望

OpenClaw 还在快速演进中，一些值得期待的方向：

- **多 Agent 协作**：多个 Agent 并行工作，处理更复杂的任务
- **视觉能力**：集成图像理解，实现截图识别、UI 自动化
- **知识库集成**：连接向量数据库，支持基于私有知识的问答
- **更丰富的 MCP 生态**：社区贡献的工具会越来越多，开箱即用的能力越来越强

### 9.3 参与贡献

OpenClaw 是开源项目，欢迎各种形式的贡献：

- **提交 Issue**：遇到问题或有什么想法，去 GitHub 提 Issue
- **贡献代码**：修复 Bug、实现新功能、优化性能
- **分享工具**：把你写的 MCP 服务器分享给社区
- **完善文档**：帮助改进教程和 API 文档
- **传播分享**：把这篇文章分享给更多开发者

---

## 最后的话

在 AI 辅助编程的时代，"造轮子"不再是贬义词。因为有了 AI，造轮子的成本已经大大降低，而从中获得的理解和掌控感是无价的。

OpenClaw 不是终点，而是一个起点。当你亲手实现并理解了它，你就具备了构建更复杂 AI 系统的能力。接下来，去打造属于你自己的工具吧。

毕竟，**最好的学习方式，就是亲手把它做出来。**
