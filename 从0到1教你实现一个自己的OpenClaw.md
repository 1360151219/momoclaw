# 从0到1教你实现一个自己的OpenClaw

## 一、引言

在 AI 助手日益普及的今天，你是否想过构建一个完全属于自己的 AI 助手框架？OpenClaw 正是这样一个开源项目，它通过容器隔离技术为 AI 代理提供了安全的执行环境。

本文将基于 MomoClaw——一个最小化的 OpenClaw 实现，带你从零开始构建一个具备容器隔离、多模型支持、工具调用能力的 AI 助手框架。我们将深入剖析其架构设计，并通过真实代码示例讲解每个核心模块的实现原理。

## 二、项目概述

### 2.1 Momo 功能介绍

MomoClaw 是一个轻量级但功能完整的 AI 助手框架，核心特性包括：

- **Docker 容器隔离**：AI 代理完全运行在容器内，确保主机安全
- **多会话支持**：可创建、切换、管理多个独立的对话会话
- **双 Provider 兼容**：同时支持 Anthropic Claude 和 OpenAI API
- **内置工具集**：文件读写、目录列表、命令执行等能力
- **流式输出**：实时响应用户输入
- **数据持久化**：SQLite 存储会话历史

### 2.2 技术栈选型

| 层级 | 技术选型 | 用途 |
|------|----------|------|
| 语言 | TypeScript | 类型安全的 JavaScript 超集 |
| 运行时 | Node.js | 服务端 JavaScript 运行环境 |
| 容器 | Docker | 应用容器化隔离 |
| 数据库 | better-sqlite3 | 轻量级关系型数据库 |
| CLI | Commander.js | 命令行界面框架 |
| API SDK | @anthropic-ai/sdk, openai | LLM API 客户端 |

### 2.3 整体架构预览

MomoClaw 采用经典的主机-容器双层架构：

```
┌─────────────────────────────────────────────────────────┐
│                    主机端 (Host)                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │   CLI 界面   │  │  数据持久层   │  │  容器编排    │ │
│  │ (index.ts)   │  │   (db.ts)    │  │ (container.ts)│ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────┘
                          │
                  ┌───────┴───────┐
                  │  Docker 边界   │
                  └───────┬───────┘
                          │
┌─────────────────────────────────────────────────────────┐
│                  容器端 (Container)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  代理核心    │  │   工具集     │  │  容器入口    │ │
│  │  (agent.ts)  │  │  (tools.ts)  │  │  (index.ts)  │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## 三、搭建项目基础

### 3.1 项目结构初始化

首先，我们来创建项目的目录结构：

```
MomoClaw/
├── host/              # 主机端代码
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
├── container/         # 容器端代码
│   ├── src/
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── workspace/         # 工作目录（挂载到容器）
├── data/              # 数据库存储
└── package.json       # 根聚合脚本
```

根目录的 `package.json` 用于聚合两个子项目的脚本：

```json
{
  "name": "MomoClaw",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "cd host && npm run build && cd ../container && npm run build",
    "dev": "cd host && npm run dev"
  }
}
```

### 3.2 核心类型定义

类型定义是整个项目的基础，让我们先看 `host/src/types.ts`：

```typescript
// host/src/types.ts
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
```

这些类型在主机端和容器端是共享的，确保了数据交换的一致性。

## 四、主机端（Host）实现

### 4.1 配置管理

配置模块负责加载环境变量并解析 API 配置：

```typescript
// host/src/config.ts
import dotenv from 'dotenv';
import { Config, ApiConfig } from './types.js';
import { resolve } from 'path';

dotenv.config();

const DEFAULT_SYSTEM_PROMPT = `You are MomoClaw, a helpful AI assistant running in an isolated Docker container.

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
    dbPath: resolve(process.env.DB_PATH || './data/MomoClaw.db'),
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
  // ... OpenAI 配置类似
}
```

### 4.2 SQLite 数据持久层

数据库模块使用 better-sqlite3，这是一个同步且高性能的 SQLite 驱动：

```typescript
// host/src/db.ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { Message, Session } from './types.js';

let db: Database.Database | null = null;

export function initDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // 创建sessions表
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0
    )
  `);

  // 创建messages表
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      tool_calls TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)`);

  return db;
}
```

会话操作函数示例：

```typescript
export function createSession(
  id: string,
  name: string,
  systemPrompt: string = '',
  model?: string
): Session {
  const db = getDb();
  const now = Date.now();

  // 先取消其他会话的active状态
  db.prepare('UPDATE sessions SET is_active = 0 WHERE is_active = 1').run();

  const stmt = db.prepare(`
    INSERT INTO sessions (id, name, system_prompt, model, created_at, updated_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);

  stmt.run(id, name, systemPrompt, model || null, now, now);

  return {
    id,
    name,
    systemPrompt,
    model: model || '',
    createdAt: now,
    updatedAt: now,
    isActive: true,
  };
}
```

### 4.3 Docker 容器编排

容器编排是 MomoClaw 的核心创新之一。它通过文件系统进行 IPC，避免了复杂的 RPC 机制：

```typescript
// host/src/container.ts
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { ContainerResult, PromptPayload } from './types.js';
import { config } from './config.js';

const CONTAINER_IMAGE = 'MomoClaw-agent:latest';

export async function runContainerAgent(
  payload: PromptPayload,
  onStream?: (chunk: string) => void
): Promise<ContainerResult> {
  const sessionId = payload.session.id;
  const runId = randomBytes(8).toString('hex');

  // 创建临时目录用于IPC
  const tempDir = join(tmpdir(), `MomoClaw-${sessionId}-${runId}`);
  const inputDir = join(tempDir, 'input');
  const outputDir = join(tempDir, 'output');

  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  // 写入prompt到输入文件
  const inputFile = join(inputDir, 'payload.json');
  writeFileSync(inputFile, JSON.stringify(payload, null, 2));

  // 准备输出文件路径
  const outputFile = join(outputDir, 'result.json');

  // 构建Docker参数
  const workspacePath = resolve(config.workspaceDir);
  const containerWorkspace = join(tempDir, 'workspace');
  mkdirSync(containerWorkspace, { recursive: true });

  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    '--network=host',
    `--memory=2g`,
    `--cpus=2`,
    `-v`, `${workspacePath}:/workspace/files:rw`,
    `-v`, `${inputDir}:/workspace/input:ro`,
    `-v`, `${outputDir}:/workspace/output:rw`,
    `-v`, `${containerWorkspace}:/workspace/tmp:rw`,
    '-e', `INPUT_FILE=/workspace/input/payload.json`,
    '-e', `OUTPUT_FILE=/workspace/output/result.json`,
    '-e', `TMP_DIR=/workspace/tmp`,
    CONTAINER_IMAGE,
    'node',
    '/app/dist/index.js',
  ];

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';

    const child = spawn('docker', dockerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 流式输出
    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      if (onStream) {
        onStream(chunk);
      }
    });

    // 超时处理
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Container timeout after ${config.containerTimeout}ms`));
    }, config.containerTimeout);

    child.on('close', (code) => {
      clearTimeout(timeoutId);

      if (code !== 0) {
        resolve({
          success: false,
          content: '',
          error: `Container exited with code ${code}. stderr: ${stderr}`,
        });
        return;
      }

      // 读取结果文件
      if (!existsSync(outputFile)) {
        resolve({
          success: false,
          content: '',
          error: 'No output file generated by container',
        });
        return;
      }

      try {
        const result: ContainerResult = JSON.parse(readFileSync(outputFile, 'utf-8'));
        resolve(result);
      } catch (err) {
        resolve({
          success: false,
          content: '',
          error: `Failed to parse result: ${err}`,
        });
      }

      // 清理临时目录
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 忽略清理错误
      }
    });
  });
}
```


这个 `runContainerAgent` 函数的核心作用是：**启动一个临时的 Docker 容器，限制其资源使用，挂载多个本地目录到容器内，设置环境变量，然后在容器内执行 Node.js 脚本处理指定的输入文件，并将结果输出到挂载目录**。

我按顺序逐个解释 Docker 命令内每个参数的含义、作用和使用场景：

| 参数片段 | 具体类型 | 详细解释 | 设计目的/注意事项 |
|----------|----------|----------|------------------|
| `'run'` | Docker 核心指令 | Docker 最基础的指令，意为“运行一个新容器”，是所有启动容器命令的起始。 | 无，必选指令。 |
| `'--rm'` | 容器生命周期参数 | `rm` = remove，意为“容器运行结束后自动删除”。 | ✅ 核心目的：避免运行完的空容器占用磁盘空间，适合一次性任务（比如脚本处理）；<br>❌ 注意：如果容器异常退出，也会被删除，如需排查问题可临时去掉。 |
| `'-i'` | 交互模式参数 | `i` = interactive，意为“以交互模式运行容器”，保持标准输入（STDIN）打开。 | 核心目的：让容器能接收外部输入（比如脚本运行时的参数传递、日志输出）；<br>补充：如果需要同时看到容器内的输出，通常会搭配 `-t`（分配伪终端），写成 `-it`。 |
| `'--network=host'` | 网络模式参数 | 将容器的网络命名空间与宿主机共享，容器直接使用宿主机的 IP 和端口，无需端口映射。 | ✅ 优点：容器内访问宿主机服务（如本地数据库、API）可直接用 `localhost`，无需配置端口映射；<br>⚠️ 注意：<br>1. 该参数仅在 Linux 系统有效（Docker Desktop for Mac/Windows 效果不同）；<br>2. 容器会占用宿主机端口，需避免端口冲突。 |
| ``--memory=2g`` | 资源限制参数 | 限制容器最多使用 2GB 内存。 | 防止容器无限制占用宿主机内存，导致宿主机卡顿或 OOM（内存溢出）；单位支持 `b/k/m/g`，需小写。 |
| ``--cpus=2`` | 资源限制参数 | 限制容器最多使用 2 个 CPU 核心（包括多核的超线程）。 | 控制容器的 CPU 使用率，避免单个容器占用过多 CPU 资源，影响宿主机其他进程。 |
| `-v`, `${workspacePath}:/workspace/files:rw` | 目录挂载参数（卷挂载） | `-v` = volume，是挂载本地目录到容器内的核心参数，格式为：`本地路径:容器内路径:权限`。<br>这里是将本地 `workspacePath` 目录挂载到容器内 `/workspace/files`，权限为 `rw`（可读可写）。 | ✅ 核心目的：让容器能读写本地的工作目录文件；<br>权限说明：`rw` = 可读可写，`ro` = 只读（后续会用到）。 |
| `-v`, `${inputDir}:/workspace/input:ro` | 目录挂载参数 | 将本地 `inputDir` 目录挂载到容器内 `/workspace/input`，权限为 `ro`（只读）。 | ✅ 设计思路：输入文件（如 `payload.json`）是只读的，设置 `ro` 可防止容器内脚本误修改本地输入文件，提升安全性。 |
| `-v`, `${outputDir}:/workspace/output:rw` | 目录挂载参数 | 将本地 `outputDir` 目录挂载到容器内 `/workspace/output`，权限 `rw`。 | 核心目的：容器内脚本生成的结果文件（`result.json`）会写入该目录，宿主机能直接获取到输出结果。 |
| `-v`, `${containerWorkspace}:/workspace/tmp:rw` | 目录挂载参数 | 将本地 `containerWorkspace` 目录挂载到容器内 `/workspace/tmp`，权限 `rw`。 | 给容器内脚本提供临时文件存储目录，避免容器内临时文件占用容器镜像的存储空间（容器内 `/tmp` 通常是临时层，重启丢失）。 |
| `-e`, `INPUT_FILE=/workspace/input/payload.json` | 环境变量参数 | `-e` = environment，设置容器内的环境变量。<br>这里设置 `INPUT_FILE` 变量值为容器内的输入文件路径。 | ✅ 核心目的：脚本（`index.js`）无需硬编码文件路径，通过读取环境变量获取输入文件位置，提升灵活性；<br>注意：路径是**容器内的路径**（对应挂载后的路径），不是本地路径。 |
| `-e`, `OUTPUT_FILE=/workspace/output/result.json` | 环境变量参数 | 设置容器内 `OUTPUT_FILE` 变量，指定结果文件的输出路径（容器内）。 | 脚本会将处理结果写入该路径，由于该目录已挂载到本地 `outputDir`，本地能直接拿到 `result.json`。 |
| `-e`, `TMP_DIR=/workspace/tmp` | 环境变量参数 | 设置容器内临时目录的环境变量，供脚本读取使用。 | 脚本可将临时文件写入该目录，保证临时文件持久化到本地（容器删除后不丢失）。 |
| `CONTAINER_IMAGE` | 镜像参数 | 这是一个变量，代表要运行的 Docker 镜像名称（如 `node:18-alpine` 或自定义镜像）。 | 容器会基于这个镜像启动，镜像内需要包含 Node.js 环境和 `/app/dist/index.js` 脚本。 |
| `'node'` | 容器内执行的命令 | 启动容器后，在容器内执行 `node` 命令（前提是镜像内已安装 Node.js）。 | 核心是调用 Node.js 运行时来执行脚本。 |
| `'/app/dist/index.js'` | 命令参数 | `node` 命令的参数，指定要运行的 Node.js 脚本路径（容器内的路径）。 | 这是容器启动后真正要执行的核心逻辑脚本，负责处理输入文件并生成输出。 |

**关键设计思路解读**

1. **资源隔离与限制**：
   - 通过 `--memory=2g` 和 `--cpus=2` 限制容器资源，避免影响宿主机稳定性，是生产环境中运行容器的最佳实践；
   - `--network=host` 简化网络配置，适合容器需要访问宿主机本地服务的场景（比如本地调试的 API、数据库）。

2. **目录挂载的权限设计**：
   - 输入目录 `inputDir` 设为 `ro` 只读：防止脚本误修改原始输入数据，符合“输入不可变”的设计原则；
   - 输出、临时、工作目录设为 `rw` 可读写：保证脚本能写入结果和临时文件，且文件能同步到本地。

3. **环境变量解耦**：
   - 输入/输出/临时目录的路径通过环境变量传递给脚本，而非硬编码在脚本内，让脚本更通用（换路径只需改环境变量，无需改脚本）。

4. **临时容器设计**：
   - `--rm` 保证容器运行完自动删除，结合 `-i` 交互模式，适合一次性的脚本处理任务（比如数据处理、批量计算）。


这个设计的巧妙之处在于：
1. **文件系统 IPC**：通过临时目录的 input/output 文件夹传递数据
2. **卷挂载分离**：工作区、输入、输出、临时目录分别挂载，读写权限分明
3. **流式透传**：容器 stdout 直接透传给主机用户

### 4.4 CLI 交互界面

最后是 CLI 入口，使用 Commander.js 定义命令，Readline 处理交互：

```typescript
// host/src/index.ts
#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'readline';
import { stdin as input, stdout as output } from 'process';
import kleur from 'kleur';
import { config, getApiConfig } from './config.js';
import { initDatabase, createSession, getSession, getActiveSession, listSessions, switchSession, deleteSession, updateSessionPrompt, updateSessionModel, addMessage, getSessionMessages, clearSessionMessages } from './db.js';
import { runContainerAgent } from './container.js';
import { PromptPayload } from './types.js';

const program = new Command();

program
  .name('MomoClaw')
  .description('MomoClaw AI Assistant - A minimal AI assistant with container isolation')
  .version('1.0.0');

// 交互式对话模式
async function interactiveChat(sessionId?: string): Promise<void> {
  let session = sessionId ? getSession(sessionId) : getActiveSession();

  if (!session) {
    session = createSession('default', 'Default Session');
    console.log(kleur.yellow(`Created default session: ${session.id}`));
  }

  const model = session.model || config.defaultModel;
  const shortModel = model.split('/').pop() || model;

  console.log(kleur.gray(`\nSession: ${kleur.cyan(session.id)} | Model: ${kleur.cyan(shortModel)}`));
  console.log(kleur.gray('Commands: /model <name> | /system <prompt> | /clear | /exit\n'));

  const rl = createInterface({ input, output });
  let isClosed = false;

  const askQuestion = () => {
    if (isClosed) return;
    const prefix = `[${session!.id}:${shortModel}]`;
    rl.question(`${kleur.gray(prefix)} > `, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        askQuestion();
        return;
      }

      // 内置命令处理
      if (trimmed === '/exit' || trimmed === '/quit') {
        console.log(kleur.gray('Goodbye!'));
        isClosed = true;
        rl.close();
        return;
      }

      if (trimmed.startsWith('/model ')) {
        const newModel = trimmed.slice(7).trim();
        updateSessionModel(session!.id, newModel);
        session = getSession(session!.id);
        console.log(kleur.gray(`Model updated to: ${newModel}`));
        askQuestion();
        return;
      }

      // 保存用户消息
      addMessage(session!.id, 'user', trimmed);

      // 获取历史消息
      const history = getSessionMessages(session!.id, 50);

      // 构建payload
      const payload: PromptPayload = {
        session: {
          ...session!,
          systemPrompt: session!.systemPrompt || config.defaultSystemPrompt,
        },
        messages: history.slice(0, -1),
        userInput: trimmed,
        apiConfig: getApiConfig(config, session!.model || undefined),
      };

      process.stdout.write(kleur.gray('Thinking...'));
      let contentBuffer = '';
      let thinkingCleared = false;

      try {
        const result = await runContainerAgent(payload, (chunk) => {
          if (!thinkingCleared) {
            process.stdout.write('\r' + ' '.repeat(20) + '\r');
            thinkingCleared = true;
          }
          process.stdout.write(chunk);
          contentBuffer += chunk;
        });

        if (result.success) {
          const finalContent = contentBuffer || result.content;
          if (contentBuffer && !contentBuffer.endsWith('\n')) {
            process.stdout.write('\n');
          } else if (!contentBuffer && finalContent) {
            console.log(finalContent);
          }
          addMessage(session!.id, 'assistant', finalContent, result.toolCalls);
        }
      } catch (err) {
        process.stdout.write('\r' + ' '.repeat(20) + '\r');
        console.error(kleur.red(`Container error: ${err}`));
      }

      setTimeout(() => askQuestion(), 10);
    });
  };

  askQuestion();
}

// 命令定义
program
  .command('new <id>')
  .description('Create a new session')
  .option('-n, --name <name>', 'Session display name')
  .option('-m, --model <model>', 'Model to use')
  .option('-s, --system <prompt>', 'System prompt')
  .action((id, options) => {
    const session = createSession(id, options.name || id, options.system || '', options.model);
    console.log(kleur.green(`Created session: ${session.id}`));
  });

program
  .command('list')
  .alias('ls')
  .description('List all sessions')
  .action(() => {
    const sessions = listSessions();
    console.log('\nSessions:');
    console.log(formatSessionList(sessions));
    console.log();
  });

// ... 其他命令定义

// Default action (interactive chat)
program.action(() => {
  interactiveChat();
});

// Run
initialize().then(() => {
  program.parse();
});
```

## 五、容器端（Container）实现

### 5.1 容器入口与 IPC

容器端的入口非常简洁，负责从文件系统读取输入、执行代理、写回结果：

```typescript
// container/src/index.ts
#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { PromptPayload, ContainerResult } from './types.js';
import { runAgent } from './agent.js';

const INPUT_FILE = process.env.INPUT_FILE || '/workspace/input/payload.json';
const OUTPUT_FILE = process.env.OUTPUT_FILE || '/workspace/output/result.json';

async function main(): Promise<void> {
  // 确保输出目录存在
  const outputDir = dirname(OUTPUT_FILE);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // 读取输入
  if (!existsSync(INPUT_FILE)) {
    const result: ContainerResult = {
      success: false,
      content: '',
      error: `Input file not found: ${INPUT_FILE}`,
    };
    writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const payload: PromptPayload = JSON.parse(readFileSync(INPUT_FILE, 'utf-8'));

  try {
    // 流式输出到stdout
    const result = await runAgent(payload, (chunk) => {
      process.stdout.write(chunk);
    });

    const output: ContainerResult = {
      success: true,
      content: result.content,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
    };

    writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  } catch (err: any) {
    const result: ContainerResult = {
      success: false,
      content: '',
      error: err.message || String(err),
    };
    writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

### 5.2 AI 代理核心逻辑

代理核心是整个系统的大脑，实现了工具调用循环和双 Provider 支持：

```typescript
// container/src/agent.ts
import Anthropic from '@anthropic-ai/sdk';
import { OpenAI } from 'openai/index.mjs';
import { PromptPayload, ToolCall, ApiConfig, Message } from './types.js';
import { getToolDefinitions, executeTool } from './tools.js';

export async function runAgent(
  payload: PromptPayload,
  onStream?: (text: string) => void
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const { provider } = payload.apiConfig;

  if (provider === 'anthropic') {
    return await runAnthropicAgent(payload, onStream);
  } else {
    return await runOpenAIAgent(payload, onStream);
  }
}

async function runAnthropicAgent(
  payload: PromptPayload,
  onStream?: (text: string) => void
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const { apiKey, model, maxTokens, baseUrl } = payload.apiConfig;
  const client = new Anthropic({ apiKey, baseURL: baseUrl });

  const messages = buildAnthropicMessages(payload);
  const tools = getToolDefinitions();

  const toolCalls: ToolCall[] = [];
  let finalContent = '';

  // 循环处理工具调用
  let continueLoop = true;
  let iterations = 0;
  const maxIterations = 10;

  while (continueLoop && iterations < maxIterations) {
    iterations++;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: payload.session.systemPrompt,
      messages,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      stream: !!onStream,
    });

    if (onStream) {
      // 流式处理
      for await (const chunk of response as AsyncIterable<Anthropic.MessageStreamEvent>) {
        if (chunk.type === 'content_block_delta') {
          const text = (chunk.delta as any).text || '';
          finalContent += text;
          onStream(text);
        }
      }

      // 流式模式下重新获取完整响应以检查工具调用
      const fullResponse = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: payload.session.systemPrompt,
        messages,
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      });

      const toolUseBlocks = fullResponse.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      if (toolUseBlocks.length > 0) {
        // 处理工具调用
        for (const block of toolUseBlocks) {
          const toolCall: ToolCall = {
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          };

          try {
            const result = await executeTool(block.name, block.input as Record<string, unknown>);
            toolCall.result = result;

            // 添加工具结果到消息
            messages.push({
              role: 'assistant',
              content: fullResponse.content as any,
            });
            messages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: block.id,
                content: result,
              }],
            });
          } catch (err: any) {
            toolCall.result = `Error: ${err.message}`;
            // ... 错误处理类似
          }

          toolCalls.push(toolCall);
        }

        // 继续循环获取AI的最终响应
        finalContent = '';
        continue;
      }

      continueLoop = false;
    } else {
      // 非流式处理（类似逻辑，略）
      // ...
    }
  }

  return { content: finalContent, toolCalls };
}
```

这里有一个关键设计：**流式输出时的两次请求**。第一次请求用于流式显示给用户，第二次非流式请求用于可靠地解析 tool_calls。

### 5.3 内置工具实现

工具模块定义了 AI 可以使用的所有能力，并包含安全检查：

```typescript
// container/src/tools.ts
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, resolve, normalize, isAbsolute } from 'path';
import { execSync } from 'child_process';
import { Tool } from './types.js';

const WORKSPACE_BASE = '/workspace/files';

// 确保路径在workspace范围内
function sanitizePath(inputPath: string): string {
  // 如果是绝对路径，检查是否在workspace内
  if (isAbsolute(inputPath)) {
    const resolved = normalize(inputPath);
    const workspaceResolved = normalize(WORKSPACE_BASE);
    if (!resolved.startsWith(workspaceResolved)) {
      throw new Error(`Path ${inputPath} is outside workspace`);
    }
    return resolved;
  }

  // 相对路径，拼接到workspace
  return resolve(WORKSPACE_BASE, inputPath);
}

export const tools: Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content as a string.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to read',
        },
        offset: {
          type: 'number',
          description: 'The line number to start reading from (1-indexed)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read',
        },
      },
      required: ['path'],
    },
    execute: async ({ path, offset, limit }) => {
      const filePath = sanitizePath(String(path));

      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${path}`);
      }

      const stats = statSync(filePath);
      if (!stats.isFile()) {
        throw new Error(`${path} is not a file`);
      }

      let content = readFileSync(filePath, 'utf-8');

      if (offset !== undefined || limit !== undefined) {
        const lines = content.split('\n');
        const start = Math.max(0, (offset as number || 1) - 1);
        const end = limit !== undefined ? start + (limit as number) : lines.length;
        content = lines.slice(start, end).join('\n');
      }

      return content;
    },
  },

  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path to the file to write' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    },
    execute: async ({ path, content }) => {
      const filePath = sanitizePath(String(path));
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));

      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(filePath, String(content), 'utf-8');
      return `File written successfully: ${path}`;
    },
  },

  {
    name: 'execute_command',
    description: 'Execute a shell command in the workspace. Use with caution.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: { type: 'string', description: 'Working directory' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['command'],
    },
    execute: async ({ command, cwd, timeout }) => {
      const workingDir = cwd ? sanitizePath(String(cwd)) : WORKSPACE_BASE;
      const cmd = String(command);
      const cmdTimeout = (timeout as number) || 60000;

      // 危险命令检查
      const dangerousPatterns = [
        /rm\s+-rf\s+\/\s*/,
        />\s*\/dev\/null/,
        /mkfs\./,
        /dd\s+if=.*of=\/dev/,
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(cmd)) {
          throw new Error(`Potentially dangerous command detected: ${cmd}`);
        }
      }

      try {
        const result = execSync(cmd, {
          cwd: workingDir,
          timeout: cmdTimeout,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return result || '(command executed successfully, no output)';
      } catch (err: any) {
        throw new Error(`Command failed: ${err.message}\nStderr: ${err.stderr}`);
      }
    },
  },

  // ... edit_file, list_directory 类似
];

export function getToolDefinitions() {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.execute(args);
}
```

### 5.4 Docker 镜像构建

最后是 Dockerfile，使用 Alpine Linux 保持轻量：

```dockerfile
# container/Dockerfile
FROM docker.m.daocloud.io/library/node:20-alpine

# 安装必要的系统工具
RUN apk update && apk add \
    git \
    curl

# 设置工作目录
WORKDIR /app

# 复制配置文件和依赖
COPY package*.json tsconfig.json ./
RUN npm ci

# 复制应用代码
COPY --chown=node:node src/ ./src/
RUN npm run build

# 创建workspace目录
RUN mkdir -p /workspace/files /workspace/input /workspace/output /workspace/tmp \
    && chown -R node:node /workspace

# 切换到非root用户
USER node

# 设置环境变量
ENV NODE_ENV=production

# 运行代理
CMD ["node", "dist/index.js"]
```

## 六、数据流全解析

现在我们通过一个完整的对话示例来看数据是如何流动的：

```
用户输入: "查看 README.md 的内容"
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ CLI 层保存消息 → addMessage('user', '查看 README.md')  │
│ 获取历史消息 → getSessionMessages(sessionId, 50)       │
│ 构建 PromptPayload                                       │
└─────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 容器层创建临时目录 /tmp/MomoClaw-s1-abc123/            │
│ 写入 input/payload.json                                  │
│ 启动 Docker，挂载卷:                                      │
│   - workspace → /workspace/files (rw)                   │
│   - input → /workspace/input (ro)                       │
│   - output → /workspace/output (rw)                     │
└─────────────────────────────────────────────────────────┘
    │
    ├──────────────── Docker 边界 ────────────────┐
    │                                               │
    ▼                                               │
┌───────────────────────────────────────────────┐  │
│ 容器读取 payload.json                           │  │
│ 调用 runAgent()                                 │  │
└───────────────────────────────────────────────┘  │
    │                                               │
    ▼                                               │
┌───────────────────────────────────────────────┐  │
│ Agent 循环 (第1次):                            │  │
│ 1. 调用 Claude API，stream=true                │  │
│    → 流式输出 "让我看看 README.md..."         │  │
│ 2. 重新请求获取 tool_calls                     │  │
│ 3. 发现 tool_use: read_file("README.md")      │  │
└───────────────────────────────────────────────┘  │
    │                                               │
    ▼                                               │
┌───────────────────────────────────────────────┐  │
│ 执行工具 executeTool("read_file", {path: "README.md"})  │
│ → sanitizePath 检查路径安全                    │  │
│ → 读取文件内容                                  │  │
└───────────────────────────────────────────────┘  │
    │                                               │
    ▼                                               │
┌───────────────────────────────────────────────┐  │
│ 添加工具结果到消息列表                          │  │
│ 继续循环 (第2次)                                │  │
└───────────────────────────────────────────────┘  │
    │                                               │
    ▼                                               │
┌───────────────────────────────────────────────┐  │
│ Agent 循环 (第2次):                            │  │
│ 1. 调用 Claude API，传入 tool_result          │  │
│ 2. 无 tool_use，返回最终内容                  │  │
│    → "README.md 介绍了 MomoClaw 项目..."      │  │
└───────────────────────────────────────────────┘  │
    │                                               │
    ▼                                               │
┌───────────────────────────────────────────────┐  │
│ 写入 output/result.json                        │  │
│ {success: true, content: "...", toolCalls: [...]}  │
└───────────────────────────────────────────────┘  │
    │                                               │
    └──────────────── Docker 边界 ────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 主机读取 result.json                                     │
│ 清理临时目录                                              │
│ 保存助手消息到数据库                                      │
└─────────────────────────────────────────────────────────┘
    │
    ▼
显示给用户
```

### 6.1 IPC 机制详解

MomoClaw 使用文件系统进行 IPC，是根据场景特点来设计的，这是一个简单但有效的设计：
  1. 不是性能瓶颈：AI API 调用是主要延迟，磁盘 IPC 的开销可以忽略
  2. 需要可靠性：文件系统 IPC 更稳定，不容易出问题
  3. 需要调试友好：中间文件可以直接查看，大大降低开发难度


```
主机                                          容器
  │                                            │
  │  /tmp/MomoClaw-${sid}-${rid}/             │
  ├── input/                                   │
  │   └── payload.json  ────────────────────→│ read
  │                                            │
  │                                            │ execute
  │                                            │
  │  /workspace/files (./workspace)           │
  │  (真实工作目录)             ←────────────→│ read/write
  │                                            │
  │  /tmp/MomoClaw-${sid}-${rid}/             │
  ├── output/                                  │
  │   └── result.json ←───────────────────────│ write
  │                                            │
```

## 七、安全设计

### 7.1 多层安全架构

MomoClaw 采用了多层安全设计来保护主机系统：

| 层级 | 措施 |
|------|------|
| **容器隔离** | Docker 容器，非 root 用户运行 |
| **资源限制** | 内存 2GB，CPU 2 核 |
| **文件系统隔离** | 仅挂载指定目录，只读/读写分离 |
| **路径白名单** | 所有文件操作限制在 `/workspace/files` |
| **命令黑名单** | 拦截危险命令模式 |
| **凭证保护** | API Key 不传递给容器 |

### 7.2 路径安全检查

`santizePath` 函数确保所有文件操作都在允许的范围内：

```typescript
function sanitizePath(inputPath: string): string {
  if (isAbsolute(inputPath)) {
    const resolved = normalize(inputPath);
    const workspaceResolved = normalize(WORKSPACE_BASE);
    if (!resolved.startsWith(workspaceResolved)) {
      throw new Error(`Path ${inputPath} is outside workspace`);
    }
    return resolved;
  }
  return resolve(WORKSPACE_BASE, inputPath);
}
```

这可以防止路径遍历攻击（如 `../../etc/passwd`）。

### 7.3 危险命令拦截

```typescript
const dangerousPatterns = [
  /rm\s+-rf\s+\/\s*/,      // rm -rf /
  />\s*\/dev\/null/,        // > /dev/null
  /mkfs\./,                  // 格式化
  /dd\s+if=.*of=\/dev/,     // dd 写设备
];
```

## 八、扩展与优化

### 8.1 添加新的 LLM Provider

要添加新的 LLM Provider（如 Gemini），只需在 `agent.ts` 中添加：

```typescript
async function runGeminiAgent(
  payload: PromptPayload,
  onStream?: (text: string) => void
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  // 实现 Gemini API 调用逻辑
  // ...
}

export async function runAgent(
  payload: PromptPayload,
  onStream?: (text: string) => void
) {
  const { provider } = payload.apiConfig;
  if (provider === 'anthropic') {
    return await runAnthropicAgent(payload, onStream);
  } else if (provider === 'openai') {
    return await runOpenAIAgent(payload, onStream);
  } else if (provider === 'gemini') {
    return await runGeminiAgent(payload, onStream);
  }
}
```

### 8.2 自定义新工具

在 `tools.ts` 中添加新工具非常简单：

```typescript
{
  name: 'search_web',
  description: 'Search the web for information',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  execute: async ({ query }) => {
    // 实现搜索逻辑
    const results = await searchAPI(query);
    return JSON.stringify(results);
  },
}
```

### 8.3 增强 CLI 功能

在 `index.ts` 中添加新命令：

```typescript
program
  .command('export <sessionId>')
  .description('Export session history to JSON')
  .action((sessionId) => {
    const messages = getSessionMessages(sessionId);
    writeFileSync(`session-${sessionId}.json`, JSON.stringify(messages, null, 2));
    console.log(kleur.green(`Exported session ${sessionId}`));
  });
```

## 九、总结

### 9.1 MomoClaw 的设计亮点

1. **简单但有效的隔离**：Docker 容器 + 文件系统 IPC，避免复杂的 RPC
2. **双 Provider 抽象**：统一的接口支持 Anthropic 和 OpenAI
3. **优雅的工具循环**：最多 10 次迭代，支持复杂的工具链
4. **会话管理**：SQLite 持久化，支持多会话切换
5. **流式输出**：实时反馈，同时获取完整结果用于工具调用解析
6. **安全第一**：路径检查、命令过滤、非 root 用户

### 9.2 学到的核心技术

- 容器化应用架构设计
- TypeScript 类型安全开发
- SQLite 数据库设计与操作
- Docker API 与容器编排
- LLM API 集成与工具调用
- 流式数据处理

### 9.3 下一步探索方向

- 添加 Web 界面（React/Vue）
- 支持更多 LLM Provider
- 实现工具插件系统
- 添加用户认证与权限管理
- 支持远程 Docker 主机

通过 MomoClaw 的实现，我们看到了一个现代化 AI 助手框架的核心设计思路。希望这篇文章能帮助你构建出属于自己的 OpenClaw！
