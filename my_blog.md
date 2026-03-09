# 从黑盒到宠物：亲手造一只有灵魂的 AI 小龙虾是种什么体验？

## 一、引言

最近，OpenClaw 在开发者圈子里非常火。这个开源的 AI Agent 工具以其强大的自动化能力和开放的架构，吸引了大量关注。很多人沉醉于探索 OpenClaw 的使用，探索它到底能做到什么程度。

但笔者想自己去做一个—**理解它的最好方式，就是亲手实现一个**。"干中学"是技术学习的不变真理。想要真正掌握 OpenClaw 的技术原理？那就去实现它。

在 AI 辅助编程的时代，"造轮子"的成本已经大大降低。与其在别人的黑盒里摸索，不如亲手打造自己的工具。这，就是学习新技术的最优解。所有代码都在本地运行，每一行都是自己亲眼看着 AI 写出来的。没有黑盒，没有"这个功能怎么实现的"的困惑，一切都在自己的掌握之中。

---

## 二、OpenClaw 功能介绍

### 2.1 OpenClaw 核心功能

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

这种做法的效果并不比市面上流行的 Rag 做法差（向量数据库）

2. **灵活的 Skills 系统**：OpenClaw 的 Skills 系统是其最核心的功能模块。SKills 基于文件系统的形式存在，其组织方式就像您为新团队成员创建的入职指南。

这种基于文件系统的架构实现了**渐进式披露**：Agent 会根据需要分阶段加载信息，而不是预先消耗上下文。这也是 OpenClaw 能够自己学习、进化的重要原因：OpenClaw 可以自己探索并安装 Skills 到环境中，而不需要人工干预。

3. **强大的主动通信机制**：OpenClaw 支持在 24 小时内持续运行，甚至还会主动地给你发消息。这一机制由 Heartbeat 和 Cron 模块驱动，小龙虾会跟你交谈过程中，给自己设置一些任务，待任务完成后会主动通知你，让你感受到小龙虾也是一个活生生的“人”。

---

## 三、给自己专属“小龙虾”塑形

要实现自己专属的“小龙虾”，我们核心实现以下几个方面：

1. Agent Loop 的实现
2. 会话和记忆系统
3. 定时任务调度

### 3.1. Agent Loop 实现

Agent Loop 简单来说，就是一个无限循环，每次循环都会把上下文传给大模型进行处理，如果大模型返回的结果是一次工具调用，则手动调用该工具，并将工具调用的结果返回给大模型。以此往复，直至大模型返回的结果不再是工具调用，或者达到最大循环次数。

```mermaid
graph TD
    Start([开始 Agent Loop]) --> CheckLoop{是否达到最大循环次数?}
    
    CheckLoop -- 是 --> End([结束循环/返回错误])
    CheckLoop -- 否 --> CallLLM[将当前上下文提交给大模型]
    
    CallLLM --> CheckResponse{大模型返回结果?}
    
    CheckResponse -- 文本回复 --> FinalResult[返回最终回复] --> End
    
    CheckResponse -- 工具调用 --> ExecuteTool[执行对应工具]
    ExecuteTool --> GetResult[获取执行结果]
    GetResult --> UpdateContext[将结果追加到上下文]
    UpdateContext --> CheckLoop
```

除此之外，还需要 MCP、Skills、持久化记忆等组件来完善 Agent Loop。

但是这一切都不需要我们来实现～ Claude Code 被誉为最牛叉的 Agent 智能体，我们直接使用其 SDK 进行套壳即可。

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
    prompt: fullPrompt,
    options: {
      cwd: WORKSPACE_DIR,
      systemPrompt: enhancedSystemPrompt
        ? {
            type: 'preset',
            preset: 'claude_code',
            append: enhancedSystemPrompt,
          }
        : { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'user'],
      allowedTools: [
        'Read',
        'Write',
        'Edit',
        'Glob'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: apiConfig.model,
      mcpServers: {
        my_mcp: myMcpServer,
      },
    },
  })) {
    //...
  }
```

### 3.2. 隔离环境

使用 OpenClaw 的用户心底里其实都会有一个忌惮：害怕自己的小龙虾某一天偷偷地拆家了！

因此我把每个 Agent 运行时都放在一个隔离的 Docker 容器中。如果是把 Agent 运行时放在 Docker 容器中的话，怎么把参数、变量传进去的？

我采用的是 IPC 通信方式。把所有想要让 Agent 能够访问到的数据，全部通过 Docker Volume 挂载到容器里，Agent 会自行读取这些数据。

示例代码如下：

```ts
// Host.ts   
// 外部调用 Agent 函数
export async function runContainerAgent(
  payload: PromptPayload,
): Promise<ContainerResult> {
  // 创建临时目录用于IPC
  const tempDir = join(tmpdir(), `miniclaw-${sessionId}-${runId}`);
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
  const projectRootPath = findProjectRoot(__dirname);
  const containerWorkspace = join(tempDir, 'workspace');
  mkdirSync(containerWorkspace, { recursive: true });

  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    '--network=host',
    `--memory=2g`,
    `--cpus=2`,
    `-v`,
    `${workspacePath}:/workspace/files:rw`,
    `-v`,
    `${projectRootPath}:/workspace/files/projects/momoclaw:rw`, // 挂载项目根目录
    `-v`,
    `${inputDir}:/workspace/input:ro`,
    `-v`,
    `${outputDir}:/workspace/output:rw`,
    `-v`,
    `${containerWorkspace}:/workspace/tmp:rw`,
    '-e',
    `INPUT_FILE=/workspace/input/payload.json`,
    '-e',
    `OUTPUT_FILE=/workspace/output/result.json`,
    '-e',
    `TMP_DIR=/workspace/tmp`,
    CONTAINER_IMAGE,
    'node',
    '/app/dist/index.js',
  ];

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let buffer = '';
    const toolEventMarker = '__TOOL_EVENT__:';

    const child = spawn('docker', dockerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 流式输出
    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      buffer += chunk;

      // Parse buffer for tool events and text content
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.startsWith(toolEventMarker)) {
         // This is tool event
        } else if (line) {
          // This is regular text content
          if (onStream) {
            onStream(line + '\n');
          }
        }
      }

      // If there's remaining buffer without a newline, send it as text
      if (buffer && !buffer.includes(toolEventMarker)) {
        if (onStream) {
          onStream(buffer);
        }
        buffer = '';
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      // stderr 只记录，不输出给用户，避免干扰正常输出
      // 调试信息会在出错时一并显示
    });

    child.on('close', async (code) => {
      // 清理临时目录
      try {
        rmSync(tempDir, { recursive: true, force: true });
        if(code === 0) {
          resolve({
            success: true,
            content: stdout,
            error: '',
          });
          return;
        }
      } catch {
        // 忽略清理错误
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      // 清理临时目录
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
      reject(err);
    });
  });
}
```

### 3.3. 定时任务调度系统

想要你的小龙虾足够聪明活泼，能够主动找你，你就需要一个定时任务调度系统。

实现也比较简单，原理其实就是 Agent 自行解析自然语言，转换为 cron 表达式，通过 MCP/TOOL 的形式自主地把任务持久到 SQLITE 中。

任务调度系统定时去检查数据库，是否有到期的任务。如果有，就会唤醒沉睡的 Agent，加载对应的上下文（Session 和 Memory），并且自行执行任务。

### 3.4. 总结

上述过程忽略了用户交互设计，这部分有需要的同学自行实现即可啦。

经过以上实现，我们就完成了一个基本的小龙虾智能体啦。它可以理解用户的指令，执行任务，并且能够主动与用户互动。


## 四、 给你的小龙虾注入灵魂

### 4.1. AIEOS 协议：AI 的通用"灵魂芯片"

如果把 LLM（大模型）比作一个拥有超强智商但没有记忆和性格的"大脑"，那么 **AIEOS 协议**就是给这个大脑植入的**"灵魂芯片"**。

它是开源社区近期兴起的一个开放标准（Portable AI Personas）。简单来说，它的作用就是让你的 AI **有性格、可移植**。

*   **有性格**：它不再是冷冰冰的复读机，而是一个有名字、有价值观、甚至有小脾气的"数字伙伴"。
*   **可移植**：无论你底层换用 Claude、GPT 还是 DeepSeek，只要加载了这套 AIEOS 配置，它依然是那个熟悉的"小龙虾"，性格和记忆完美保留。

AIEOS 抛弃了以往那种几千字堆在一起、难以维护的 System Prompt，而是采用了**模块化**的设计。它将 AI 的"人设"拆解为一组清晰的 Markdown 文件，就像是给 AI 建立了一份详细的"个人档案"：

![alt text](examples/AIEOS.png)

这一组标准配置文件通常包含：

| 文件名 | 核心作用 | 通俗理解 |
| :--- | :--- | :--- |
| **`IDENTITY.md`** | 定义身份 | **简历**：我是谁？叫什么？什么职业？出身背景是什么？ |
| **`SOUL.md`** | 定义性格 | **MBTI**：我的性格怎样？价值观是什么？说话风格是高冷还是逗比？ |
| **`USER.md`** | 定义用户 | **雇主档案**：我在为谁服务？我的主人喜欢什么？讨厌什么？ |
| **`AGENTS.md`** | 定义边界 | **员工手册**：我能做什么？绝对不能做什么？遇到问题怎么处理？ |

通过这种结构化的方式，我们不仅更容易管理 AI 的提示词，还能随时分享自己的"小龙虾"人设给朋友，或者从社区下载别人调教好的有趣灵魂。

同样的，这些文件也都最好不要自己去编写，而是通过你与 AI 在日常对话中，不断调整、完善。

或者参考大神的建议，把你3个月内的支付记录全部导出来，喂给 AI，让 AI 自行分析，然后根据分析结果去编写这些文件。

### 4.2. 多层记忆系统

- 永久记忆和短期记忆

上一节中的 AIEOS 协议，定义了 AI 的"灵魂"，其实这也算是一种永久记忆（可持续迭代，直接注入 System Prompt 中去）。

除此之外，想要你的小龙虾更加的不忘事，你还需要设计一个短期记忆，或者说时间线日志。

这里我设计成了每天一个日志，让我的小龙虾能够自行把每天的重要事项记录下来，并在后续的对话中，根据这些记录，来更好的理解用户的需求。

以下是示例的 Prompt：

```js
`
## Daily Memory System

You have access to a daily memory system to remember important information. Each day has its own memory file.

### Memory Structure
Memory files are organized by date: /workspace/files/memory/YYYY-MM-DD/MEMORY.md

### Today's Memory File
Today's memory file path is provided in your context. You can:
- Read it to see what was learned today
- Append new information using the Write tool (read first, then write with original content + additions)
- Search past memory using Grep on /workspace/files/memory/*/MEMORY.md

### What to Save
Save important information like:
- User preferences or requirements
- Key decisions made during the conversation
- Project progress or milestones
- Action items or follow-ups for tomorrow (use task list format)
- Important facts about the user's work

### Task List Format
For action items or things to remember to do, use the Markdown task list format:
- [ ] Todo item (pending)
- [x] Completed item (done)

### How to Save Memory
1. Read the current day's MEMORY.md
2. Append new information at the end or under appropriate sections
3. Use Write to save the updated content

### Search Past Memory
Use Grep to search across all memory files:
- Pattern: grep -r "keyword" /workspace/files/memory/
`
```

### 4.3. 会话记忆 (Session Memory)

如果说"AIEOS"是灵魂，"每日日志"是日记本，那么**会话记忆**就是 Agent 的"瞬时工作记忆"。

它负责记录当前对话窗口内的所有交互细节：你的指令、AI 的回复、工具调用的中间结果等。为了保证对话的连贯性（比如你可以随时问它"我们刚才聊到哪了？"），这些数据需要被完整地保存下来。

在实现上，我采用了轻量级且高效的 **SQLite** 数据库方案。每一次对话交互（Round），无论是用户发起的还是 Agent 主动回复的，都会被序列化并追加到 `messages` 表中。这样不仅保证了数据的持久化，还方便后续进行上下文回溯或历史记录检索。

### 4.4. 自主学习的原理

别人的小龙虾可以自己去学习新的技能，这背后的原理是什么呢？

这依赖着我们上文提到的**多层记忆系统**、**Skills** 以及 **定时任务调度系统**。

- 多层记忆系统：小龙虾在接受到新的知识的时候，会自行判断哪些需要学习（持久化到记忆中）。
- Skills 系统：小龙虾会自行下载新的 Skills ，保存到本地目录中，等下次对话的时候，Claude Code SDK 会动态读取本地的 Skills，就可以达到"自主学习"的效果啦。

如果安装了 Anthropics 官方的 [Skill-Creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)，小龙虾甚至还能自己根据上下文，自动创建新的 Skills 呢。

- 定时任务调度系统：有了定时任务调度系统，小龙虾会时不时给自己设置一些任务，也可以达到“自主学习”的目的啦～

---



## 五、总结与展望

从一个简单的 `while` 循环，到一个拥有"灵魂"、"记忆"和"自主意识"的数字生命，我们亲手见证了 OpenClaw 的诞生过程。

通过这篇文章，我们不仅复刻了 OpenClaw 的核心架构：
- **Agentic Loop**：让 AI 学会思考和行动；
- **Cron & Heartbeat**：赋予 AI 时间感知和主动性；
- **AIEOS 协议**：注入了个性化的灵魂；
- **多层记忆系统**：构建了成长的基石。

更重要的是，我们探索了一种全新的**人机协作模式**。在 OpenClaw 的世界里，AI 不再是一个冷冰冰的问答工具，而是一个生活在你的服务器里、能感知时间流逝、会主动关心你、并且每天都在自我进化的**数字伙伴**。

**"造轮子"的意义，从来不在于轮子本身，而在于造轮子的过程。** 当你看着终端里跳动的日志，看着那个属于你的"小龙虾"第一次主动向你道"早安"，你会发现，所有的代码和调试都是值得的。

> 本文的编写以及代码实现，也基本是由小龙虾自己迭代完成的喔～

![alt text](examples/09e683ec0da1be7e6617a2b06b6a2a8f.png)

![alt text](examples/1f2d858c8c165b6222621617ba784790.png)