# Momoclaw 定时任务机制分析报告

> 分析日期：2026-04-21
> 分析范围：`host/src/cron/`、`host/src/mcp/server.ts`、`host/src/db/tasks.ts`、`host/src/container.ts` 及相关模块

---

## 一、架构总览

Momoclaw 的定时任务系统采用 **Host 端轮询调度 + Docker 容器执行 + 多渠道推送** 的三层架构。

### 1.1 整体架构图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              用户交互层                                        │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐      │
│  │   飞书群聊   │   │   微信对话   │   │   Web 终端  │   │   CLI 终端  │      │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘      │
└─────────┼─────────────────┼─────────────────┼─────────────────┼──────────────┘
          │                 │                 │                 │
          ▼                 ▼                 ▼                 ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Host 宿主机 (Node.js)                               │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                        MCP Server (Express + SSE)                    │    │
│  │  ┌───────────────┐  ┌───────────────────┐  ┌───────────────────┐   │    │
│  │  │ schedule_task │  │ list_scheduled_   │  │   delete_task     │   │    │
│  │  │   创建任务     │  │   tasks 查询列表   │  │    删除任务       │   │    │
│  │  └───────┬───────┘  └───────────────────┘  └───────────────────┘   │    │
│  └──────────┼──────────────────────────────────────────────────────────┘    │
│             │                                                                 │
│             ▼                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                      CronService (调度器核心)                          │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │   │
│  │  │  start() ──> setInterval(checkAndRunTasks, pollIntervalMs)      │ │   │
│  │  │              │                                                  │ │   │
│  │  │              ▼                                                  │ │   │
│  │  │  checkAndRunTasks() ──> getDueTasks(now) ──> 到期任务列表        │ │   │
│  │  │              │                                                  │ │   │
│  │  │              ▼                                                  │ │   │
│  │  │  executingTasks Set (防重复执行)                                 │ │   │
│  │  │              │                                                  │ │   │
│  │  │              ▼                                                  │ │   │
│  │  │  sessionQueue.enqueue(sessionId, () => executeTask(task))       │ │   │
│  │  └─────────────────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│             │                                                                 │
│             ▼                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                      SessionQueue (会话级串行队列)                      │   │
│  │                                                                       │   │
│  │   同一 Session 的任务串行执行 ────── 不同 Session 的任务并发执行        │   │
│  │                                                                       │   │
│  │   Session A: [Task1] ──> [Task2] ──> [Task3]                         │   │
│  │   Session B: [Task4] ──> [Task5]                                     │   │
│  │   Session C: [Task6]                                                 │   │
│  │                                                                       │   │
│  │   以上三个 Session 的任务队列可以同时并发执行                           │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│             │                                                                 │
│             ▼                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    ContainerManager (容器管理器)                       │   │
│  │                                                                       │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │   │
│  │  │ getOrStartContainer │  │ 闲置超时清理     │  │ 进程退出时销毁      │  │   │
│  │  │ 获取或启动容器   │  │ (30分钟无活动)   │  │ destroyAllContainers│  │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│             │                                                                 │
└─────────────┼─────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Docker Container (隔离执行环境)                        │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        AgentRunner.run()                              │   │
│  │                                                                       │   │
│  │  1. 准备输入文件: payload.json ──> /workspace/session_tmp/{runId}/    │   │
│  │  2. 设置环境变量: INPUT_FILE, OUTPUT_FILE, HOST_MCP_URL, etc.         │   │
│  │  3. 执行命令: docker exec ... node /app/dist/index.js                 │   │
│  │  4. 实时流式输出: stdout ──> onStream(chunk)                          │   │
│  │  5. 工具事件: __TOOL_EVENT__ 前缀 ──> onToolEvent(event)              │   │
│  │  6. 读取结果: result.json <── /workspace/session_tmp/{runId}/output/  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│             │                                                                 │
│             ▼                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Claude Agent SDK (AI 执行引擎)                      │   │
│  │                                                                       │   │
│  │  - 解析用户 prompt                                                    │   │
│  │  - 调用 MCP 工具 (Host MCP Server)                                    │   │
│  │  - 生成响应内容                                                       │   │
│  │  - 输出结果到 result.json                                             │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           结果推送层                                          │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     ChannelRegistry (渠道注册中心)                     │   │
│  │                                                                       │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │   │
│  │  │ FeishuCronHandler│  │ WeixinCronHandler│  │ TerminalCronHandler │  │   │
│  │  │   飞书推送        │  │   微信推送        │  │    终端输出          │  │   │
│  │  │ sendMessage()   │  │ sendMessage()   │  │  console.log()      │  │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           数据持久层 (SQLite)                                 │
│                                                                               │
│  ┌─────────────────────────────────────┐  ┌─────────────────────────────┐   │
│  │        scheduled_tasks 表           │  │      task_run_logs 表        │   │
│  │  - id (主键)                        │  │  - id (自增主键)             │   │
│  │  - session_id (外键)                │  │  - task_id (外键)            │   │
│  │  - prompt (执行指令)                │  │  - executed_at (执行时间)     │   │
│  │  - schedule_type (cron/interval/once)│  │  - success (是否成功)        │   │
│  │  - schedule_value (调度参数)         │  │  - output (输出内容)         │   │
│  │  - status (active/paused/completed/failed)│  │  - error (错误信息)          │   │
│  │  - next_run (下次执行时间戳)         │  └─────────────────────────────┘   │
│  │  - last_run (上次执行时间戳)         │                                    │
│  │  - last_result (上次执行结果)        │                                    │
│  │  - run_count (执行次数)              │                                    │
│  │  - channel_type (推送渠道类型)       │                                    │
│  │  - channel_id (渠道 ID)              │                                    │
│  └─────────────────────────────────────┘                                    │
│                                                                               │
│  索引:                                                                        │
│  - idx_tasks_next_run(next_run, status)  ← 轮询查询优化                       │
│  - idx_tasks_channel(channel_type, channel_id)  ← 渠道查询优化                │
│  - idx_task_logs(task_id, executed_at)  ← 日志查询优化                        │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心文件清单

| 文件路径 | 职责描述 | 关键函数/类 |
|---------|---------|------------|
| [host/src/cron/scheduler.ts](file:///Users/bytedance/workspace/momoclaw/host/src/cron/scheduler.ts) | 定时任务调度器核心 | `CronService` 类：`start()`, `checkAndRunTasks()`, `executeTask()`, `calculateNextRun()` |
| [host/src/cron/executor.ts](file:///Users/bytedance/workspace/momoclaw/host/src/cron/executor.ts) | 容器工具调用处理器 | `executeCronActions()`: 处理 6 种操作（创建/列表/暂停/恢复/删除/日志） |
| [host/src/cron/sender.ts](file:///Users/bytedance/workspace/momoclaw/host/src/cron/sender.ts) | 渠道注册中心 | `ChannelRegistry` 类：`register()`, `sendMessage()`, `isAvailable()` |
| [host/src/mcp/server.ts](file:///Users/bytedance/workspace/momoclaw/host/src/mcp/server.ts) | Host MCP Server | 暴露 3 个 MCP 工具：`schedule_task`, `list_scheduled_tasks`, `delete_task` |
| [host/src/db/tasks.ts](file:///Users/bytedance/workspace/momoclaw/host/src/db/tasks.ts) | 数据库操作层 | `createScheduledTask()`, `getDueTasks()`, `updateTaskAfterRun()`, `addTaskRunLog()` |
| [host/src/types.ts](file:///Users/bytedance/workspace/momoclaw/host/src/types.ts) | 类型定义 | `ScheduledTask`, `TaskRunLog`, `ChannelHandler`, `ScheduleType`, `TaskStatus` |
| [host/src/core/sessionQueue.ts](file:///Users/bytedance/workspace/momoclaw/host/src/core/sessionQueue.ts) | 会话级串行队列 | `SessionQueue` 类：`enqueue()` |
| [host/src/container.ts](file:///Users/bytedance/workspace/momoclaw/host/src/container.ts) | Docker 容器管理 | `ContainerManager`, `AgentRunner`, `runContainerAgent()` |
| [host/src/feishu/cronHandler.ts](file:///Users/bytedance/workspace/momoclaw/host/src/feishu/cronHandler.ts) | 飞书渠道推送 | `FeishuCronHandler` 类：`sendMessage()`, `formatTaskResult()` |
| [host/src/weixin/cronHandler.ts](file:///Users/bytedance/workspace/momoclaw/host/src/weixin/cronHandler.ts) | 微信渠道推送 | `WeixinCronHandler` 类：`sendMessage()`, `formatTaskResult()` |

---

## 二、调度类型与数据模型

### 2.1 三种调度类型详解

```typescript
// 定义于 types.ts
export type ScheduleType = 'cron' | 'interval' | 'once';
```

| 类型 | `scheduleValue` 格式 | 示例 | 使用场景 | 实现原理 |
|------|---------------------|------|---------|---------|
| `cron` | 标准 Cron 表达式 (5 位) | `"0 9 * * *"` | 每天 9 点执行 | 使用 `cron-parser` 库计算下次执行时间 |
| `interval` | 间隔秒数 (字符串) | `"3600"` | 每小时执行一次 | `now + parseInt(scheduleValue) * 1000` |
| `once` | 13 位毫秒时间戳 | `"1709542800000"` | 一次性任务 | 执行完成后 `nextRun = null`，状态变为 `completed` |

#### Cron 表达式详解

```
┌───────────── 分钟 (0 - 59)
│ ┌───────────── 小时 (0 - 23)
│ │ ┌───────────── 日期 (1 - 31)
│ │ │ ┌───────────── 月份 (1 - 12)
│ │ │ │ ┌───────────── 星期几 (0 - 6, 0=周日)
│ │ │ │ │
* * * * *

示例:
"0 9 * * *"      → 每天 09:00
"*/5 * * * *"    → 每 5 分钟
"0 9 * * 1-5"    → 周一到周五 09:00
"0 0 1 * *"      → 每月 1 号 00:00
```

### 2.2 四种任务状态流转

```
                                    ┌─────────────────┐
                                    │                 │
                                    │    created      │
                                    │   (初始创建)     │
                                    │                 │
                                    └────────┬────────┘
                                             │
                                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                   active                                     │
│                                  (活跃状态)                                   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         正常执行循环                                   │  │
│  │                                                                       │  │
│  │   active ──执行成功──> calculateNextRun() ──有下次时间──> active       │  │
│  │      │                                                                │  │
│  │      └──执行成功──> calculateNextRun() ──无下次时间──> completed       │  │
│  │             (once 类型任务)                                           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
        │                    │
        │ 用户暂停            │ 执行失败
        ▼                    ▼
┌───────────────┐    ┌───────────────┐
│               │    │               │
│    paused     │    │    failed     │
│   (暂停状态)   │    │   (失败状态)   │
│               │    │               │
└───────┬───────┘    └───────┬───────┘
        │                    │
        │ 用户恢复            │ 用户恢复 (resume_task)
        │ (resume_task)      │ (重新计算 nextRun)
        │                    │
        └────────────────────┴──────────────────> active
```

### 2.3 数据库表结构

#### scheduled_tasks 表 (任务主表)

```sql
CREATE TABLE scheduled_tasks (
    id TEXT PRIMARY KEY,                        -- 任务 ID，格式: task-{timestamp36}-{randomHex}
    session_id TEXT NOT NULL,                   -- 关联的会话 ID
    prompt TEXT NOT NULL,                       -- 执行指令内容
    schedule_type TEXT NOT NULL                 -- 调度类型: 'cron' | 'interval' | 'once'
        CHECK(schedule_type IN ('cron', 'interval', 'once')),
    schedule_value TEXT NOT NULL,               -- 调度参数值
    status TEXT NOT NULL DEFAULT 'active'       -- 任务状态
        CHECK(status IN ('active', 'paused', 'completed', 'failed')),
    next_run INTEGER,                           -- 下次执行时间戳 (毫秒)
    last_run INTEGER,                           -- 上次执行时间戳 (毫秒)
    last_result TEXT,                           -- 上次执行结果摘要
    run_count INTEGER NOT NULL DEFAULT 0,       -- 累计执行次数
    created_at INTEGER,                         -- 创建时间戳
    updated_at INTEGER,                         -- 最后更新时间戳
    channel_type TEXT,                          -- 推送渠道类型: 'feishu' | 'weixin' | 'terminal'
    channel_id TEXT,                            -- 渠道特定 ID (如飞书 chat_id)
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 性能优化索引
CREATE INDEX idx_tasks_next_run ON scheduled_tasks(next_run, status);  -- 轮询查询
CREATE INDEX idx_tasks_channel ON scheduled_tasks(channel_type, channel_id);  -- 渠道查询
```

#### task_run_logs 表 (执行日志表)

```sql
CREATE TABLE task_run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,       -- 自增主键
    task_id TEXT NOT NULL,                      -- 关联的任务 ID
    executed_at INTEGER NOT NULL,               -- 执行时间戳 (毫秒)
    success INTEGER NOT NULL DEFAULT 0,         -- 是否成功 (0/1)
    output TEXT NOT NULL DEFAULT '',            -- 输出内容
    error TEXT                                  -- 错误信息 (如果有)
);

-- 性能优化索引
CREATE INDEX idx_task_logs ON task_run_logs(task_id, executed_at);
```

---

## 三、核心执行流程详解

### 3.1 任务创建流程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              任务创建完整流程                                  │
└──────────────────────────────────────────────────────────────────────────────┘

用户输入                    AI Agent                    MCP Server              数据库
   │                          │                           │                      │
   │  "每天早上9点提醒我喝水"   │                           │                      │
   │ ────────────────────────>│                           │                      │
   │                          │                           │                      │
   │                          │ 解析意图:                  │                      │
   │                          │ - scheduleType: "cron"    │                      │
   │                          │ - scheduleValue: "0 9 * * *"                    │
   │                          │ - prompt: "提醒用户喝水"   │                      │
   │                          │                           │                      │
   │                          │ 调用 MCP 工具              │                      │
   │                          │ schedule_task             │                      │
   │                          │ ─────────────────────────>│                      │
   │                          │                           │                      │
   │                          │                           │ 步骤1: 生成任务 ID    │
   │                          │                           │ CronService          │
   │                          │                           │ .generateTaskId()    │
   │                          │                           │ ─────────────────────>│
   │                          │                           │                      │
   │                          │                           │ 步骤2: 计算首次执行时间
   │                          │                           │ CronService          │
   │                          │                           │ .calculateInitialNextRun()
   │                          │                           │ ─────────────────────>│
   │                          │                           │                      │
   │                          │                           │ 步骤3: 写入数据库     │
   │                          │                           │ createScheduledTask()│
   │                          │                           │ ─────────────────────>│
   │                          │                           │                      │
   │                          │                           │        ┌─────────────┤
   │                          │                           │        │ INSERT INTO │
   │                          │                           │        │ scheduled_  │
   │                          │                           │        │ tasks       │
   │                          │                           │        └─────────────┤
   │                          │                           │                      │
   │                          │                           │ 返回任务信息          │
   │                          │<─────────────────────────│                      │
   │                          │                           │                      │
   │                          │ 返回用户友好的确认信息     │                      │
   │<─────────────────────────│                           │                      │
   │                          │                           │                      │
   │  "任务创建成功！          │                           │                      │
   │   任务ID: task-xxx        │                           │                      │
   │   下次执行: 2026/4/22 9:00"│                          │                      │
   │                          │                           │                      │
```

#### 源码解析：任务创建

```typescript
// === mcp/server.ts - MCP 工具定义 ===
server.tool(
  'schedule_task',
  `【创建定时任务】当用户要求在未来的某个时间、或者每隔一段时间重复执行某项操作时...`,
  {
    sessionId: z.string().optional(),
    prompt: z.string().describe('定时执行的提示词'),
    scheduleType: z.enum(['cron', 'once']),  // 注意: interval 未暴露
    scheduleValue: z.string(),
  },
  async ({ sessionId, prompt, scheduleType, scheduleValue }) => {
    // 1. 生成唯一任务 ID
    const taskId = CronService.generateTaskId();
    // 返回: "task-{时间戳36进制}-{8位随机hex}"

    // 2. 计算首次执行时间
    const nextRun = CronService.calculateInitialNextRun(
      scheduleType as any,
      scheduleValue,
    );

    // 3. 写入数据库
    const task = createScheduledTask(
      taskId,
      actualSessionId,
      prompt,
      scheduleType,
      scheduleValue,
      nextRun,
      channelContext.channelType,  // 推送渠道类型
      channelContext.channelId,    // 渠道 ID
    );

    // 4. 返回确认信息
    return {
      content: [{
        type: 'text',
        text: `任务创建成功！任务ID: \`${taskId}\` \n下次执行时间: ${new Date(nextRun).toLocaleString()}`,
      }],
    };
  },
);
```

```typescript
// === cron/scheduler.ts - 任务 ID 生成 ===
static generateTaskId(): string {
  // 时间戳转 36 进制 + 4 字节随机 hex
  return `task-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}
// 示例输出: "task-m1abc-3f8e2a1b"
```

```typescript
// === cron/scheduler.ts - 计算首次执行时间 ===
static calculateInitialNextRun(
  scheduleType: ScheduleType,
  scheduleValue: string,
): number {
  const now = Date.now();

  switch (scheduleType) {
    case 'once': {
      // 尝试解析 ISO 日期字符串或毫秒时间戳
      let timestamp = new Date(scheduleValue).getTime();
      if (isNaN(timestamp)) {
        timestamp = new Date(Number(scheduleValue)).getTime();
      }
      return isNaN(timestamp) ? now : timestamp;  // 注意: 无效值会立即执行
    }

    case 'interval': {
      const seconds = parseInt(scheduleValue, 10);
      return now + seconds * 1000;  // 当前时间 + 间隔
    }

    case 'cron': {
      // 使用 cron-parser 计算下次执行时间
      const interval = CronExpressionParser.parse(cronExpr, {
        currentDate: new Date(now),
      });
      return interval.next().getTime();
    }
  }
}
```

### 3.2 调度轮询流程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              调度轮询完整流程                                  │
└──────────────────────────────────────────────────────────────────────────────┘

CronService                    数据库                    SessionQueue
    │                            │                            │
    │ === 系统启动 ===            │                            │
    │                            │                            │
    │ start()                    │                            │
    │ ├─ checkAndRunTasks()      │  ← 立即执行一次             │
    │ └─ setInterval(            │                            │
    │      checkAndRunTasks,     │                            │
    │      pollIntervalMs        │  ← 默认 10 秒轮询           │
    │    )                       │                            │
    │                            │                            │
    │ === 每 10 秒执行 ===        │                            │
    │                            │                            │
    │ checkAndRunTasks()         │                            │
    │ │                          │                            │
    │ │ 获取到期任务              │                            │
    │ │ getDueTasks(Date.now())  │                            │
    │ │ ────────────────────────>│                            │
    │ │                          │                            │
    │ │         ┌────────────────┤                            │
    │ │         │ SELECT * FROM  │                            │
    │ │         │ scheduled_     │                            │
    │ │         │ tasks          │                            │
    │ │         │ WHERE next_run │                            │
    │ │         │   <= now       │                            │
    │ │         │   AND status   │                            │
    │ │         │   = 'active'   │                            │
    │ │         └────────────────┤                            │
    │ │                          │                            │
    │ │ 返回到期任务列表          │                            │
    │ │<─────────────────────────│                            │
    │ │                          │                            │
    │ │ for (task of dueTasks):  │                            │
    │ │                          │                            │
    │ │   检查是否正在执行         │                            │
    │ │   if (executingTasks     │                            │
    │ │       .has(task.id))     │                            │
    │ │     continue;  ← 跳过     │                            │
    │ │                          │                            │
    │ │   标记为执行中            │                            │
    │ │   executingTasks         │                            │
    │ │     .add(task.id)        │                            │
    │ │                          │                            │
    │ │   加入会话队列            │                            │
    │ │   sessionQueue.enqueue(  │                            │
    │ │     task.sessionId,      │                            │
    │ │     () => executeTask(   │                            │
    │ │       task               │                            │
    │ │     )                    │                            │
    │ │   )                      │                            │
    │ │ ─────────────────────────────────────────────────────>│
    │ │                          │                            │
    │ │                          │          ┌─────────────────┤
    │ │                          │          │ 同一 Session    │
    │ │                          │          │ 的任务串行排队   │
    │ │                          │          │ 不同 Session    │
    │ │                          │          │ 可并发执行      │
    │ │                          │          └─────────────────┤
    │ │                          │                            │
    │ │ await Promise.all(       │                            │
    │ │   taskPromises           │  ← 等待所有任务完成         │
    │ │ )                        │                            │
    │ │                          │                            │
```

#### 源码解析：调度轮询

```typescript
// === cron/scheduler.ts - CronService 类 ===
export class CronService {
  private running = false;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;         // 轮询间隔
  private executingTasks = new Set<string>();      // 正在执行的任务 ID 集合

  constructor(options: CronServiceOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 10000;  // 默认 10 秒
  }

  /**
   * 启动调度器
   */
  start(): void {
    if (this.running) return;  // 防止重复启动

    this.running = true;
    console.log('[CronService] Scheduler started');

    // 立即检查一次
    this.checkAndRunTasks();

    // 设置定时轮询
    this.intervalId = setInterval(() => {
      this.checkAndRunTasks();
    }, this.pollIntervalMs);
  }

  /**
   * 检查并执行到期的任务
   */
  private async checkAndRunTasks(): Promise<void> {
    if (!this.running) return;

    const now = Date.now();
    const dueTasks = getDueTasks(now);  // 从数据库获取到期任务

    const taskPromises = dueTasks.map(async (task) => {
      // 防止同一任务被并发执行
      if (this.executingTasks.has(task.id)) return;

      this.executingTasks.add(task.id);  // 标记为执行中

      try {
        // 使用 sessionQueue 保证同一 Session 的任务串行执行
        await sessionQueue.enqueue(task.sessionId, () =>
          this.executeTask(task),
        );
      } catch (err) {
        console.error(`[CronService] Task ${task.id} failed:`, err);

        // 记录失败日志
        const errorMsg = err instanceof Error ? err.message : String(err);
        addTaskRunLog(task.id, false, '', errorMsg);
        updateTaskAfterRun(task.id, this.calculateNextRun(task), errorMsg, 'failed');
      } finally {
        this.executingTasks.delete(task.id);  // 移除执行中标记
      }
    });

    // 跨会话并发执行所有任务
    await Promise.all(taskPromises);
  }
}
```

```typescript
// === core/sessionQueue.ts - 会话级串行队列 ===
export class SessionQueue {
  private queues: Map<string, Promise<any>> = new Map();

  /**
   * 将任务加入特定会话的队列中
   * - 相同会话的任务串行执行
   * - 不同会话的任务可并发执行
   */
  async enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    // 获取当前会话的最后一个 Promise
    const currentPromise = this.queues.get(sessionId) || Promise.resolve();

    // 创建新的 Promise，在上一个完成后执行 task
    const nextPromise = currentPromise.then(() => task());

    // 无论成功还是失败，都生成一个确保 resolve 的 Promise 存入队列
    const safePromise = nextPromise.catch((err) => {
      console.error(`[SessionQueue] Task error:`, err);
    });

    this.queues.set(sessionId, safePromise);

    // 任务结束后清理，避免内存泄漏
    safePromise.finally(() => {
      if (this.queues.get(sessionId) === safePromise) {
        this.queues.delete(sessionId);
      }
    });

    return nextPromise;
  }
}
```

### 3.3 任务执行流程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              任务执行完整流程                                  │
└──────────────────────────────────────────────────────────────────────────────┘

CronService              ContainerManager           AgentRunner            Docker容器
    │                          │                         │                      │
    │ executeTask(task)        │                         │                      │
    │ │                        │                         │                      │
    │ ├─1. 获取会话信息         │                         │                      │
    │ │  getSession() 或       │                         │                      │
    │ │  getActiveSessionFor   │                         │                      │
    │ │  Channel()             │                         │                      │
    │ │                        │                         │                      │
    │ ├─2. 构建 payload        │                         │                      │
    │ │  - session 信息         │                         │                      │
    │ │  - userInput (带前缀)   │                         │                      │
    │ │  - apiConfig           │                         │                      │
    │ │                        │                         │                      │
    │ ├─3. 运行容器 Agent       │                         │                      │
    │ │  runContainerAgent()   │                         │                      │
    │ │ ───────────────────────│────────────────────────>│                      │
    │ │                        │                         │                      │
    │ │                        │    getOrStartContainer()│                      │
    │ │                        │<────────────────────────│                      │
    │ │                        │                         │                      │
    │ │                        │ 检查容器是否存在          │                      │
    │ │                        │ ├─ 存在: 更新 lastAccessed                    │
    │ │                        │ └─ 不存在: 启动新容器     │                      │
    │ │                        │    docker run -d ...     │ ─────────────────────>│
    │ │                        │                         │      启动容器         │
    │ │                        │                         │                      │
    │ │                        │ 返回容器信息             │                      │
    │ │                        │────────────────────────>│                      │
    │ │                        │                         │                      │
    │ │                        │                         │ 准备执行环境          │
    │ │                        │                         │ ├─ 创建 runDir       │
    │ │                        │                         │ ├─ 写入 payload.json │
    │ │                        │                         │ └─ 设置环境变量       │
    │ │                        │                         │                      │
    │ │                        │                         │ docker exec ...      │
    │ │                        │                         │ node /app/dist/index.js
    │ │                        │                         │ ─────────────────────>│
    │ │                        │                         │                      │
    │ │                        │                         │                      │ Claude Agent
    │ │                        │                         │                      │ 执行 prompt
    │ │                        │                         │                      │ │
    │ │                        │                         │                      │ ├─ 调用 MCP 工具
    │ │                        │                         │                      │ ├─ 生成响应
    │ │                        │                         │                      │ └─ 写入 result.json
    │ │                        │                         │                      │
    │ │                        │                         │ 实时流式输出          │
    │ │                        │                         │<─────────────────────│
    │ │<─────────────────────────────────────────────────│                      │
    │ │                        │                         │                      │
    │ │                        │                         │ 读取 result.json      │
    │ │                        │                         │ ─────────────────────>│
    │ │                        │                         │                      │
    │ │                        │                         │ 返回执行结果          │
    │ │<─────────────────────────────────────────────────│                      │
    │ │                        │                         │                      │
    │ ├─4. 保存消息历史         │                         │                      │
    │ │  addMessage(user)      │                         │                      │
    │ │  addMessage(assistant) │                         │                      │
    │ │                        │                         │                      │
    │ ├─5. 记录执行日志         │                         │                      │
    │ │  addTaskRunLog()       │                         │                      │
    │ │                        │                         │                      │
    │ ├─6. 计算下次执行时间     │                         │                      │
    │ │  calculateNextRun()    │                         │                      │
    │ │                        │                         │                      │
    │ ├─7. 更新任务状态         │                         │                      │
    │ │  updateTaskAfterRun()  │                         │                      │
    │ │                        │                         │                      │
    │ ├─8. 推送结果到渠道       │                         │                      │
    │ │  pushResultToChannel() │                         │                      │
    │ │                        │                         │                      │
    │ ▼                        │                         │                      │
```

#### 源码解析：任务执行

```typescript
// === cron/scheduler.ts - executeTask 方法 ===
private async executeTask(task: ScheduledTask): Promise<void> {
  console.log(`[CronService] Executing task: ${task.id}`);

  // 步骤1: 优先通过渠道信息查找用户当前活跃的 session
  // 这样用户 /new 切换会话后，任务结果会写入新会话
  let session = task.channelType && task.channelId
    ? getActiveSessionForChannel(task.channelType, task.channelId)
    : undefined;

  if (!session) {
    session = getSession(task.sessionId);  // 兜底用任务创建时的 session
  }

  if (!session) {
    throw new Error(`Session not found: ${task.sessionId}`);
  }

  // 步骤2: 构建定时任务执行提示词
  let executionPrompt = [
    '[Scheduled Task]',
    '这是一个定时触发的独立任务，请忽略之前的对话上下文，专注执行以下指令。',
    `任务ID: ${task.id} | 已执行次数: ${task.runCount}`,
  ].join('\n');

  // 注入上次执行结果摘要
  if (task.runCount > 0) {
    const lastLogs = getTaskRunLogs(task.id, 1);
    if (lastLogs.length > 0 && lastLogs[0].success && lastLogs[0].output) {
      const summary = lastLogs[0].output.slice(0, 500);
      executionPrompt += `\n[上次执行结果摘要]: ${summary}`;
    }
  }

  executionPrompt += `\n\n[执行指令]: ${task.prompt}`;

  // 构建 payload
  const payload: PromptPayload = {
    session: {
      ...session,
      systemPrompt: session.systemPrompt || config.defaultSystemPrompt,
    },
    messages: [],  // 容器端将使用 resume(claudeSessionId) 加载历史
    userInput: executionPrompt,
    apiConfig: getApiConfig(config, session.model || undefined),
  };

  const activeSessionId = session.id;
  let output = '';
  let error: string | undefined;
  let success = false;
  let toolCalls: ToolCall[] | undefined;

  try {
    // 步骤3: 在 Docker 容器中运行 AI Agent
    const result = await runContainerAgent(payload, (chunk) => {
      output += chunk;  // 实时收集输出
    });

    success = result.success;

    if (result.success) {
      output = output || result.content;
      toolCalls = result.toolCalls;

      // 步骤4: 保存消息到对话历史
      addMessage(activeSessionId, 'user', executionPrompt);
      addMessage(activeSessionId, 'assistant', output, toolCalls);
    } else {
      error = result.error || 'Unknown error';
      output = result.content;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    success = false;
  }

  try {
    // 步骤5: 记录执行日志
    addTaskRunLog(task.id, success, output, error);

    // 步骤6: 计算下次执行时间
    const nextRun = this.calculateNextRun(task);

    // 步骤7: 更新任务状态
    const resultMsg = success ? 'Success' : `Failed: ${error}`;
    updateTaskAfterRun(
      task.id,
      nextRun,
      resultMsg,
      nextRun === null ? 'completed' : undefined,
    );
  } catch (err) {
    console.error(`[CronService] Failed to save task run log:`, err);
  }

  // 步骤8: 推送结果到对应渠道
  await this.pushResultToChannel(task, output, error, success);
}
```

```typescript
// === container.ts - runContainerAgent 函数 ===
export function runContainerAgent(
  payload: PromptPayload,
  onStream?: (chunk: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
): Promise<ContainerResult> {
  return agentRunner.run(payload, onStream, onToolEvent);
}

// AgentRunner.run 核心逻辑
public async run(
  payload: PromptPayload,
  onStream?: (chunk: string) => void,
  onToolEvent?: (event: ToolEvent) => void,
): Promise<ContainerResult> {
  const sessionId = payload.session.id;

  // 获取或启动容器
  const activeContainer = await this.manager.getOrStartContainer(sessionId);

  // 准备输入输出目录
  const runDir = join(activeContainer.sessionDir, runId);
  const inputFile = join(runDir, 'input/payload.json');
  const outputFile = join(runDir, 'output/result.json');

  // 写入 payload
  writeFileSync(inputFile, safeStringify(payload));

  // 构建 docker exec 命令
  const dockerArgs = [
    'exec', '-i',
    '-e', `INPUT_FILE=/workspace/session_tmp/${runId}/input/payload.json`,
    '-e', `OUTPUT_FILE=/workspace/session_tmp/${runId}/output/result.json`,
    '-e', `HOST_MCP_URL=http://host.docker.internal:${hostMcpPort}`,
    '-u', 'node',
    activeContainer.containerName,
    'node', '/app/dist/index.js',
  ];

  // 执行并处理输出流
  const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  // 实时流式输出处理
  child.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    // 区分普通输出和工具事件
    if (line.startsWith('__TOOL_EVENT__:')) {
      const event = JSON.parse(line.slice('__TOOL_EVENT__:'.length));
      onToolEvent?.(event);
    } else {
      onStream?.(line + '\n');
    }
  });

  // 设置超时
  const timeoutId = setTimeout(() => {
    child.kill('SIGTERM');
  }, config.containerTimeout);

  // 等待执行完成
  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timeoutId);

      if (code !== 0 || !existsSync(outputFile)) {
        resolve({ success: false, content: '', error: '...' });
        return;
      }

      // 读取结果
      const result = JSON.parse(readFileSync(outputFile, 'utf-8'));
      resolve(result);
    });
  });
}
```

### 3.4 结果推送流程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              结果推送完整流程                                  │
└──────────────────────────────────────────────────────────────────────────────┘

CronService              ChannelRegistry         FeishuCronHandler      飞书 API
    │                          │                        │                   │
    │ pushResultToChannel()    │                        │                   │
    │ │                        │                        │                   │
    │ ├─ 检查渠道信息           │                        │                   │
    │ │  if (!channelType ||   │                        │                   │
    │ │      !channelId)       │                        │                   │
    │ │    return;             │                        │                   │
    │ │                        │                        │                   │
    │ ├─ 构建推送内容           │                        │                   │
    │ │  content = success ?   │                        │                   │
    │ │    output :            │                        │                   │
    │ │    "❌ 任务执行失败"     │                        │                   │
    │ │                        │                        │                   │
    │ ├─ 调用渠道注册中心       │                        │                   │
    │ │  channelRegistry       │                        │                   │
    │ │    .sendMessage(       │                        │                   │
    │ │      type,             │                        │                   │
    │ │      channelId,        │                        │                   │
    │ │      content           │                        │                   │
    │ │    )                   │                        │                   │
    │ │ ──────────────────────>│                        │                   │
    │ │                        │                        │                   │
    │ │                        │ 获取对应的 Handler      │                   │
    │ │                        │ handler = handlers     │                   │
    │ │                        │   .get(type)           │                   │
    │ │                        │                        │                   │
    │ │                        │ 检查可用性              │                   │
    │ │                        │ if (!handler ||        │                   │
    │ │                        │     !handler           │                   │
    │ │                        │       .isAvailable())  │                   │
    │ │                        │   return false;        │                   │
    │ │                        │                        │                   │
    │ │                        │ 调用 Handler 发送       │                   │
    │ │                        │ handler.sendMessage(   │                   │
    │ │                        │   channelId,           │                   │
    │ │                        │   content              │                   │
    │ │                        │ )                      │                   │
    │ │                        │ ──────────────────────>│                   │
    │ │                        │                        │                   │
    │ │                        │                        │ 格式化消息         │
    │ │                        │                        │ formatted =       │
    │ │                        │                        │   formatTaskResult│
    │ │                        │                        │   (content)       │
    │ │                        │                        │                   │
    │ │                        │                        │ 调用飞书 API       │
    │ │                        │                        │ sender.sendText(  │
    │ │                        │                        │   chatId,         │
    │ │                        │                        │   formatted       │
    │ │                        │                        │ )                 │
    │ │                        │                        │ ─────────────────>│
    │ │                        │                        │                   │
    │ │                        │                        │      发送消息      │
    │ │                        │                        │<──────────────────│
    │ │                        │                        │                   │
    │ │                        │ 返回发送结果           │                   │
    │ │<────────────────────────────────────────────────│                   │
    │ │                        │                        │                   │
```

#### 源码解析：结果推送

```typescript
// === cron/scheduler.ts - pushResultToChannel 方法 ===
private async pushResultToChannel(
  task: ScheduledTask,
  output: string,
  error: string | undefined,
  success: boolean,
): Promise<void> {
  // 如果没有渠道信息，直接返回
  if (!task.channelType || !task.channelId) {
    console.log(`[CronService] Task ${task.id} has no channel info, skipping push`);
    return;
  }

  // 构建推送内容
  const content = success
    ? output || '任务执行完成（无输出）'
    : `❌ 任务执行失败: ${error || '未知错误'}`;

  // 通过 ChannelRegistry 推送
  const pushed = await channelRegistry.sendMessage(
    task.channelType,
    task.channelId,
    content,
  );

  if (pushed) {
    console.log(`[CronService] Task ${task.id} result pushed to ${task.channelType}`);
  } else {
    console.log(`[CronService] Failed to push task ${task.id} result`);
  }
}
```

```typescript
// === cron/sender.ts - ChannelRegistry 类 ===
class ChannelRegistry {
  private handlers = new Map<ChannelType, ChannelHandler>();

  /**
   * 注册渠道处理器
   */
  register(handler: ChannelHandler): void {
    this.handlers.set(handler.type, handler);
  }

  /**
   * 发送消息到指定渠道
   */
  async sendMessage(
    type: ChannelType,
    channelId: string,
    content: string,
  ): Promise<boolean> {
    const handler = this.handlers.get(type);
    if (!handler || !handler.isAvailable()) {
      console.log(`[ChannelRegistry] Channel ${type} not available`);
      return false;
    }

    try {
      await handler.sendMessage(channelId, content);
      return true;
    } catch (err) {
      console.error(`[ChannelRegistry] Failed to send to ${type}:`, err);
      return false;
    }
  }
}

export const channelRegistry = new ChannelRegistry();  // 单例
```

```typescript
// === feishu/cronHandler.ts - 飞书渠道处理器 ===
export class FeishuCronHandler implements ChannelHandler {
  readonly type: ChannelType = 'feishu';
  private sender?: FeishuSender;

  isAvailable(): boolean {
    return this.sender !== undefined;
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    if (!this.sender) {
      throw new Error('Feishu sender not initialized');
    }

    // 格式化消息
    const formatted = this.formatTaskResult(content);
    await this.sender.sendText(chatId, formatted);
  }

  private formatTaskResult(content: string): string {
    return [
      '🤖 **定时任务执行结果**',
      '',
      '---',
      '',
      content,
    ].join('\n');
  }
}
```

```typescript
// === weixin/cronHandler.ts - 微信渠道处理器 ===
export class WeixinCronHandler implements ChannelHandler {
  readonly type: ChannelType = 'weixin';
  private gateway?: WeixinGateway;

  async sendMessage(chatId: string, content: string): Promise<void> {
    const formatted = this.formatTaskResult(content);
    const client = this.gateway.getClient();

    // 加载本地 token
    const hasToken = client.loadLocalToken();
    if (!hasToken) {
      throw new Error('Weixin token not available');
    }

    await client.sendTextMessage(chatId, formatted, contextToken);
  }

  private formatTaskResult(content: string): string {
    return [
      '🤖 [定时任务执行结果]',
      '',
      '---',
      '',
      content,
    ].join('\n');
  }
}
```

---

## 四、MCP 工具接口详解

### 4.1 工具暴露层级

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            MCP 工具暴露层级                                   │
└──────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         MCP Server (server.ts)                               │
│                                                                              │
│  对外暴露的 3 个工具 (可通过自然语言调用):                                      │
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐     │
│  │  schedule_task  │  │ list_scheduled_tasks│  │    delete_task      │     │
│  │    创建任务      │  │      查询列表        │  │      删除任务       │     │
│  └─────────────────┘  └─────────────────────┘  └─────────────────────┘     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ 调用
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Executor (executor.ts)                               │
│                                                                              │
│  实际支持的 6 种操作:                                                         │
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐     │
│  │ mcp__momoclaw_  │  │ mcp__momoclaw_      │  │ mcp__momoclaw_      │     │
│  │ mcp__schedule_  │  │ mcp__list_scheduled_│  │ mcp__delete_task    │     │
│  │ task            │  │ tasks               │  │                     │     │
│  │    ✅ 已暴露     │  │      ✅ 已暴露       │  │      ✅ 已暴露       │     │
│  └─────────────────┘  └─────────────────────┘  └─────────────────────┘     │
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐     │
│  │ mcp__momoclaw_  │  │ mcp__momoclaw_      │  │ mcp__momoclaw_      │     │
│  │ mcp__pause_task │  │ mcp__resume_task    │  │ mcp__get_task_logs  │     │
│  │    ❌ 未暴露     │  │      ❌ 未暴露       │  │      ❌ 未暴露       │     │
│  └─────────────────┘  └─────────────────────┘  └─────────────────────┘     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 已暴露的 MCP 工具

#### schedule_task - 创建定时任务

```typescript
server.tool(
  'schedule_task',
  `【创建定时任务】当用户要求在未来的某个时间、或者每隔一段时间重复执行某项操作时，必须使用此工具。
请根据 scheduleType 严格遵守以下 scheduleValue 格式要求：
1. type="cron": 表示每隔一段时间需要重复执行的表达式，使用标准 Cron 表达式 (分 时 日 月 周)。
   - 示例: "0 9 * * *" (每天09:00), "*/5 * * * *" (每5分钟)
2. type="once": 表示一次性执行（例如"明天早上8点提醒我"），必须使用 13 位毫秒级时间戳 (Unix Timestamp)。
   - 示例: "1709542800000"
   - ⚠️ 严禁使用 "2024-03-04" 或 "tomorrow" 等自然语言或相对时间。`,
  {
    sessionId: z.string().optional().describe('关联的会话ID（可以不传）'),
    prompt: z.string().describe('定时执行的提示词'),
    scheduleType: z.enum(['cron', 'once']).describe('调度类型'),
    scheduleValue: z.string().describe('调度参数值'),
  },
  // ... handler
);
```

#### list_scheduled_tasks - 查询任务列表

```typescript
server.tool(
  'list_scheduled_tasks',
  `【查询定时任务列表】当用户询问"我有几个定时任务"、"帮我看看我有哪些定时任务"时，必须使用此工具获取已创建的任务列表。`,
  {},
  async () => {
    // 优先按渠道查询，兜底按 sessionId 查询
    let tasks;
    if (channelContext.channelType && channelContext.channelId) {
      tasks = listTasksByChannel(channelContext.channelType, channelContext.channelId);
    } else {
      tasks = listScheduledTasks(channelContext.sessionId);
    }
    return {
      content: [{
        type: 'text',
        text: `查询到定时任务列表如下:\n${JSON.stringify(tasks, null, 2)}`,
      }],
    };
  },
);
```

#### delete_task - 删除任务

```typescript
server.tool(
  'delete_task',
  '【删除定时任务】当用户要求取消、删除或停止某个定时提醒、定时计划时使用。',
  {
    taskId: z.string().describe('需要删除的定时任务的 ID'),
  },
  async ({ taskId }) => {
    const success = deleteScheduledTask(taskId);
    return {
      content: [{
        type: 'text',
        text: success ? `任务 ${taskId} 已成功删除。` : `删除失败：未找到任务 ${taskId}。`,
      }],
    };
  },
);
```

### 4.3 未暴露但已实现的操作

以下操作在 `executor.ts` 中已实现，但未在 MCP Server 中暴露为工具：

| 操作名 | 功能 | 实现位置 |
|--------|------|---------|
| `pause_task` | 暂停任务 | [executor.ts](file:///Users/bytedance/workspace/momoclaw/host/src/cron/executor.ts) |
| `resume_task` | 恢复任务（重新计算 nextRun） | [executor.ts](file:///Users/bytedance/workspace/momoclaw/host/src/cron/executor.ts) |
| `get_task_logs` | 查看执行日志 | [executor.ts](file:///Users/bytedance/workspace/momoclaw/host/src/cron/executor.ts) |

```typescript
// executor.ts 中 pause_task 的实现
case 'mcp__momoclaw_mcp__pause_task': {
  const taskId = payload.taskId as string;
  if (!taskId) {
    return { success: false, message: 'Missing required field: taskId' };
  }

  const success = updateTaskStatus(taskId, 'paused');
  return success
    ? { success: true, message: `Task ${taskId} paused` }
    : { success: false, message: `Task ${taskId} not found` };
}

// executor.ts 中 resume_task 的实现
case 'mcp__momoclaw_mcp__resume_task': {
  const taskId = payload.taskId as string;
  const task = getScheduledTask(taskId);
  if (!task) {
    return { success: false, message: `Task ${taskId} not found` };
  }

  // 如果任务是 completed 状态，重新计算下次执行时间
  const nextRun = task.status === 'completed'
    ? CronService.calculateInitialNextRun(task.scheduleType, task.scheduleValue)
    : task.nextRun;

  updateTaskNextRun(taskId, nextRun);
  const success = updateTaskStatus(taskId, 'active');

  return success
    ? { success: true, message: `Task ${taskId} resumed`, data: { nextRun } }
    : { success: false, message: `Failed to resume task ${taskId}` };
}

// executor.ts 中 get_task_logs 的实现
case 'mcp__momoclaw_mcp__get_task_logs': {
  const taskId = payload.taskId as string;
  const limit = Math.min(Math.max(parseInt(payload.limit as string) || 10, 1), 100);

  if (!taskId) {
    return { success: false, message: 'Missing required field: taskId' };
  }

  const logs = getTaskRunLogs(taskId, limit);
  return {
    success: true,
    data: logs,
    message: `Found ${logs.length} log entries`,
  };
}
```

---

## 五、容器管理机制详解

### 5.1 容器生命周期

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            容器生命周期管理                                    │
└──────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         ContainerManager                                     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        activeContainers Map                          │   │
│  │                                                                      │   │
│  │  sessionId ──────> ActiveContainer {                                 │   │
│  │                       sessionId: string,                             │   │
│  │                       containerName: string,                         │   │
│  │                       sessionDir: string,                            │   │
│  │                       lastAccessed: timestamp,                       │   │
│  │                       isDestroying?: boolean                         │   │
│  │                     }                                                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  定时清理 (每分钟):                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  cleanupIdleContainers():                                            │   │
│  │    for container in activeContainers:                                │   │
│  │      if (now - container.lastAccessed > 30分钟):                     │   │
│  │        ├─ performAutoSummary()  // 触发收尾 SOP                      │   │
│  │        ├─ destroyContainer()    // docker rm -f                      │   │
│  │        └─ activeContainers.delete(sessionId)                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  进程退出时:                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  process.on('exit', () => destroyAllContainers())                    │   │
│  │  process.on('SIGINT', () => process.exit())                          │   │
│  │  process.on('SIGTERM', () => process.exit())                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

容器状态流转:

  ┌─────────────┐     getOrStartContainer()     ┌─────────────┐
  │   不存在    │ ─────────────────────────────>│    活跃     │
  │             │     docker run -d ...         │             │
  └─────────────┘                               └──────┬──────┘
                                                       │
                                                       │ 30分钟无活动
                                                       │ 或进程退出
                                                       ▼
                                                ┌─────────────┐
                                                │    销毁     │
                                                │ docker rm -f│
                                                └─────────────┘
```

### 5.2 容器启动流程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            容器启动详细流程                                    │
└──────────────────────────────────────────────────────────────────────────────┘

getOrStartContainer(sessionId)
        │
        ▼
┌───────────────────────────────────┐
│ 检查 activeContainers Map         │
│ 是否存在该 sessionId              │
└───────────────────┬───────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
   已存在                    不存在
        │                       │
        ▼                       ▼
┌───────────────┐    ┌───────────────────────────────────────────┐
│ 更新时间戳     │    │ 准备容器环境                               │
│ lastAccessed  │    │ ├─ 创建 sessionDir                         │
│ = Date.now()  │    │ ├─ 创建 claudeDir                          │
│               │    │ ├─ 写入 .claude.json                       │
│ 返回容器信息   │    │ └─ chmod 递归设置权限                       │
└───────────────┘    └───────────────────┬───────────────────────┘
                                         │
                                         ▼
                     ┌───────────────────────────────────────────┐
                     │ 清理可能存在的旧容器                        │
                     │ docker rm -f momoclaw-{sessionId}         │
                     └───────────────────┬───────────────────────┘
                                         │
                                         ▼
                     ┌───────────────────────────────────────────┐
                     │ 启动新容器                                 │
                     │                                           │
                     │ docker run -d \                           │
                     │   --name momoclaw-{sessionId} \           │
                     │   --add-host=host.docker.internal:host-gateway \
                     │   --memory=2g \                           │
                     │   --cpus=2 \                              │
                     │   -v {workspace}:/workspace/files:rw \    │
                     │   -v {projectRoot}:/workspace/files/projects/momoclaw:rw \
                     │   -v {sessionDir}:/workspace/session_tmp:rw \
                     │   -v {claudeDir}:/home/node/.claude:rw \  │
                     │   momoclaw-agent:latest \                 │
                     │   tail -f /dev/null                       │
                     │                                           │
                     │ (容器后台保活，等待任务执行)                 │
                     └───────────────────┬───────────────────────┘
                                         │
                                         ▼
                     ┌───────────────────────────────────────────┐
                     │ 存入 activeContainers Map                  │
                     │ 返回 ActiveContainer 对象                  │
                     └───────────────────────────────────────────┘
```

### 5.3 容器执行流程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            容器执行详细流程                                    │
└──────────────────────────────────────────────────────────────────────────────┘

AgentRunner.run(payload)
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 步骤1: 获取容器                                                            │
│ activeContainer = await manager.getOrStartContainer(sessionId)            │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 步骤2: 准备执行目录                                                         │
│ ├─ runDir = sessionDir/{runId}                                            │
│ ├─ inputDir = runDir/input                                                │
│ ├─ outputDir = runDir/output                                              │
│ └─ workspaceDir = runDir/workspace                                        │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 步骤3: 写入输入文件                                                         │
│ writeFileSync(inputDir/payload.json, safeStringify(payload))              │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 步骤4: 构建 docker exec 命令                                                │
│                                                                           │
│ docker exec -i \                                                          │
│   -e INPUT_FILE=/workspace/session_tmp/{runId}/input/payload.json \       │
│   -e OUTPUT_FILE=/workspace/session_tmp/{runId}/output/result.json \      │
│   -e CONTEXT7_API_KEY={key} \                                             │
│   -e GITHUB_TOKEN={token} \                                               │
│   -e TMP_DIR=/workspace/session_tmp/{runId}/workspace \                   │
│   -e HOST_MCP_URL=http://host.docker.internal:{port}/sse \                │
│   -u node \                                                               │
│   {containerName} \                                                       │
│   node /app/dist/index.js                                                 │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 步骤5: 执行并处理输出流                                                      │
│                                                                           │
│ spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] })        │
│                                                                           │
│ stdout 处理:                                                               │
│ ├─ 以 '\n' 分行                                                           │
│ ├─ 如果以 '__TOOL_EVENT__:' 开头:                                         │
│ │   └─ JSON.parse(line.slice(16)) ──> onToolEvent(event)                 │
│ └─ 否则: onStream(line + '\n')                                            │
│                                                                           │
│ stderr 处理:                                                               │
│ └─ 收集错误信息                                                            │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 步骤6: 设置超时保护                                                         │
│ setTimeout(() => child.kill('SIGTERM'), config.containerTimeout)          │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 步骤7: 等待执行完成并读取结果                                                │
│                                                                           │
│ child.on('close', (code) => {                                             │
│   if (code !== 0 || !existsSync(outputFile)) {                            │
│     return { success: false, error: '...' };                              │
│   }                                                                       │
│   const result = JSON.parse(readFileSync(outputFile, 'utf-8'));           │
│   return result;                                                          │
│ });                                                                       │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 步骤8: 清理临时目录                                                         │
│ rmSync(runDir, { recursive: true, force: true })                          │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 六、用户体验分析与优化建议

### 问题 1：MCP 工具暴露不完整 🔴 严重

**现状**：MCP Server 只暴露了 `schedule_task`、`list_scheduled_tasks`、`delete_task` 三个工具，但 Executor 支持 `pause_task`、`resume_task`、`get_task_logs` 三个额外操作。

**影响**：用户无法通过自然语言对话来暂停/恢复任务或查看执行日志。例如用户说"暂停那个每天提醒我喝水的任务"，AI Agent 没有对应工具可以调用。

**建议**：在 `server.ts` 中补全以下 MCP 工具注册：
- `pause_task` — 暂停定时任务
- `resume_task` — 恢复定时任务
- `get_task_logs` — 查看任务执行日志

---

### 问题 2：`interval` 类型在 MCP 层被屏蔽 🟡 中等

**现状**：`schedule_task` 工具的 `scheduleType` 参数只允许 `'cron' | 'once'`，但底层数据库和调度器完整支持 `interval` 类型。

```typescript
// server.ts — 只暴露了 cron 和 once
scheduleType: z.enum(['cron', 'once'])
```

**影响**：用户说"每隔 30 分钟提醒我休息"时，AI 只能把它翻译成 Cron 表达式 `*/30 * * * *`，虽然功能等价，但 `interval` 语义更自然直观。

**建议**：考虑将 `interval` 类型也暴露出来，或者在工具描述中说明可以用 Cron 表达式实现间隔功能。

---

### 问题 3：任务创建时缺乏人类可读的时间确认 🟡 中等

**现状**：创建任务成功后，返回的信息是：

```
任务创建成功！任务ID: `task-xxx`
下次执行时间: 2026/4/21 09:00:00
```

**影响**：
- 使用 `toLocaleString()` 输出时间，格式取决于服务器 locale，可能不符合用户所在时区
- 对于 Cron 任务，缺少对调度规则的人类可读解释（如"每天 9:00 执行"）
- 缺少对 Cron 表达式的回显确认，用户无法确认 AI 是否正确理解了自己的意图

**建议**：
1. 在返回信息中增加 Cron 表达式的人类可读翻译（如 `"0 9 * * *"` → "每天 09:00"）
2. 增加时区信息的明确标注
3. 对于一次性任务，显示距离执行的倒计时

---

### 问题 4：任务失败后缺乏重试机制 🟡 中等

**现状**：任务执行失败后直接标记为 `failed` 状态，不会自动重试。

```typescript
// scheduler.ts
addTaskRunLog(task.id, false, '', errorMsg);
updateTaskAfterRun(task.id, this.calculateNextRun(task), errorMsg, 'failed');
```

**影响**：
- 网络波动、Docker 容器临时不可用等瞬态错误会导致任务永久失败
- 对于重复执行的 Cron 任务，一次失败就停止所有后续执行，过于严格
- 用户需要手动 resume 才能恢复（而且 resume 工具还没在 MCP 层暴露）

**建议**：
1. 对于 `cron` 和 `interval` 类型的任务，失败后不应该标记为 `failed`，而应保持 `active` 并继续调度下一次执行
2. 增加 `maxRetries` 字段，允许设定失败重试次数
3. 只有在连续多次失败后才标记为 `failed`
4. 失败时的推送消息中，告知用户可以如何恢复

---

### 问题 5：轮询间隔不一致 🟢 轻微

**现状**：存在两个不同的轮询间隔：
- `CronService` 构造函数默认值：**10 秒**
- 导出的单例实例：**30 秒**

```typescript
// scheduler.ts — 构造函数默认 10 秒
this.pollIntervalMs = options.pollIntervalMs ?? 10000;

// scheduler.ts — 单例实例 30 秒
export const cronService = new CronService({ pollIntervalMs: 30000 });
```

**影响**：
- 10 秒轮询在任务量小时有些频繁，增加不必要的数据库查询开销
- 导出的单例实例 `cronService` 可能造成误用

**建议**：
1. 统一轮询间隔配置，建议 15-30 秒
2. 将轮询间隔放入 `config.ts` 统一管理
3. 移除未使用的导出单例，或改用主入口创建的实例

---

### 问题 6：任务列表查询返回原始 JSON 🟡 中等

**现状**：`list_scheduled_tasks` 工具直接返回 JSON：

```typescript
text: `查询到定时任务列表如下:\n${JSON.stringify(tasks, null, 2)}`
```

**影响**：
- AI Agent 收到的是原始 JSON，再转述给用户时可能格式不友好
- 时间戳是毫秒数字，不是人类可读的日期时间
- 状态值是英文（`active`、`paused`），不利于中文用户理解

**建议**：
1. 在返回 JSON 之前将时间戳转换为可读日期
2. 增加任务状态的中文映射
3. 考虑在工具描述中指示 AI 以表格形式展示给用户

---

### 问题 7：`once` 任务时间解析存在安全隐患 🟡 中等

**现状**：虽然工具描述中强调"必须使用 13 位毫秒时间戳"，但 `calculateInitialNextRun` 实际上也接受 ISO 日期字符串：

```typescript
// scheduler.ts
let timestamp = new Date(scheduleValue).getTime();  // 先尝试 ISO 日期
if (isNaN(timestamp)) {
  timestamp = new Date(Number(scheduleValue)).getTime();  // 再尝试时间戳
}
return isNaN(timestamp) ? now : timestamp;  // 都失败则立即执行
```

**影响**：
- 如果 AI 传入了无效值，任务会**立即执行**（`return now`），这可能不是用户期望的行为
- 工具描述与实际行为不一致，增加了意外行为的风险

**建议**：
1. 对于无效时间值，应该返回错误而非静默立即执行
2. 如果要支持 ISO 日期字符串，则在工具描述中声明支持
3. 增加时间验证：一次性任务的执行时间必须在未来

---

### 问题 8：缺少任务编辑功能 🟡 中等

**现状**：用户无法修改已创建的定时任务的内容。如果想修改执行频率或 prompt 内容，只能删除后重新创建。

**影响**：用户说"把那个喝水提醒改成每两小时一次"时，AI 需要执行删除+创建两步操作，体验不够流畅。

**建议**：增加 `update_task` 工具，允许修改任务的 `prompt`、`scheduleType`、`scheduleValue`。

---

### 问题 9：缺少时区支持 🟡 中等

**现状**：所有时间计算都基于服务器本地时区，`cron-parser` 使用系统默认时区。

**影响**：
- 如果服务器部署在不同时区，Cron 表达式的执行时间可能与用户预期不符
- 用户说"每天早上 9 点"，但服务器在 UTC 时区，实际可能在用户的下午执行
- 多渠道用户可能来自不同时区

**建议**：
1. 在 `scheduled_tasks` 表中增加 `timezone` 字段
2. 在 `schedule_task` 工具中增加 `timezone` 参数
3. 在 `cron-parser` 调用时传入用户指定的时区

---

## 七、优化优先级汇总

| 优先级 | 问题编号 | 问题描述 | 实现难度 |
|--------|---------|---------|---------|
| 🔴 高 | #1 | MCP 工具暴露不完整（缺少暂停/恢复/日志） | 低 |
| 🟡 中 | #4 | Cron/interval 任务失败后不应停止后续执行 | 低 |
| 🟡 中 | #7 | once 任务无效时间值静默立即执行 | 低 |
| 🟡 中 | #3 | 缺乏人类可读的时间确认和 Cron 翻译 | 中 |
| 🟡 中 | #6 | 任务列表返回原始 JSON 格式不友好 | 低 |
| 🟡 中 | #8 | 缺少任务编辑功能 | 中 |
| 🟡 中 | #9 | 缺少时区支持 | 中 |
| 🟡 中 | #2 | interval 类型在 MCP 层被屏蔽 | 低 |
| 🟢 低 | #5 | 轮询间隔不一致 | 低 |

---

## 八、总体评价

### 优点

1. **架构设计清晰** — Host-Container 分层、ChannelRegistry 注册模式、SessionQueue 串行保证，都是良好的工程实践
2. **容器化执行安全隔离** — 每次定时任务在 Docker 容器中运行 AI Agent，避免宿主机污染
3. **多渠道推送可扩展** — 通过 `ChannelHandler` 接口和注册中心模式，新增渠道非常容易
4. **数据库索引合理** — `idx_tasks_next_run(next_run, status)` 索引精准覆盖了轮询查询
5. **防重复执行机制** — `executingTasks` Set + `SessionQueue` 双重保证
6. **容器生命周期管理** — 闲置超时清理、进程退出销毁、自动收尾 SOP 等机制完善

### 不足

1. **功能完整性** — MCP 层工具暴露不全，部分能力只能通过容器内部触发
2. **容错性** — 失败处理过于简单粗暴，缺乏重试和降级机制
3. **用户感知** — 缺少人类可读的信息展示、实时反馈和主动提醒
4. **配置灵活性** — 轮询间隔硬编码、缺少时区支持、清理策略不可配

---

*报告完*
