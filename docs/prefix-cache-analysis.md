# MomoClaw Prefix Cache 全面分析报告

## 一、项目架构概述

MomoClaw 采用 **Host + Container** 双组件架构：
- **Host** 负责 CLI/Bot 接口、DB 管理、MCP Server
- **Container** 在 Docker 内运行，使用 `@anthropic-ai/claude-agent-sdk` 调用 Claude API

核心 LLM 调用链路：
```
用户输入 → Host chatService → 写 payload JSON → Docker exec Container → Claude Agent SDK query() → Anthropic API
```

---

## 二、LLM API 调用分析

### 2.1 唯一的 LLM 调用点

所有 LLM 请求都通过 [container/src/index.ts](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts) 中的 [runAgentWithSDK](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L41-L239) 函数发起，使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 方法：

```typescript
for await (const message of query({
    prompt: userInput,
    options: queryOptions,
})) { ... }
```

### 2.2 SDK 配置构造（关键代码）

在 [container/src/index.ts#L75-L117](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L75-L117) 中：

```typescript
const queryOptions: Options = {
    cwd: WORKSPACE_DIR,
    ...(session.claudeSessionId ? { resume: session.claudeSessionId } : {}),
    systemPrompt: enhancedSystemPrompt
      ? { type: 'preset', preset: 'claude_code', append: enhancedSystemPrompt }
      : { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user'],
    model: apiConfig.model,
    mcpServers: {
      momoclaw_mcp: articleFetcherMcpServer,
      browser_mcp: browserMcpServer,
      ...(process.env.HOST_MCP_URL
        ? { host_mcp: { type: 'sse', url: `${process.env.HOST_MCP_URL}?channelType=${channelContext?.type}&channelId=${channelContext?.channelId}&sessionId=${session.id}` } }
        : {}),
      context7: { type: 'http', url: 'https://mcp.context7.com/mcp', ... },
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', ... },
    },
};
```

---

## 三、发现的 Prefix Cache 问题及分析

### 问题 1：host_mcp URL 中包含动态查询参数 [严重]

**位置**：[container/src/index.ts#L98](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L98)

```typescript
url: `${process.env.HOST_MCP_URL}?channelType=${channelContext?.type}&channelId=${channelContext?.channelId}&sessionId=${session.id}`
```

**问题**：`host_mcp` 的 URL 中拼接了 `channelType`、`channelId` 和 `sessionId`，这三个值每次请求都可能不同。由于 `mcpServers` 配置是 SDK options 的一部分，会被序列化进发给 Anthropic API 的请求中（作为 tool definitions 的一部分），因此每次 URL 变化都会导致 tool 定义部分不同，**直接破坏 Prefix Cache**。

**影响**：每个不同的 channelType/channelId/sessionId 组合都会导致 cache miss。

**优化建议**：
- 将 `channelType`、`channelId`、`sessionId` 从 URL 参数中剥离，改为在 MCP 连接建立后通过消息传递
- 或者使用固定 URL，在 MCP Server 侧通过 session 上下文管理映射关系

---

### 问题 2：host_mcp 服务器条件性注入 [中等]

**位置**：[container/src/index.ts#L94-L101](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L94-L101)

```typescript
...(process.env.HOST_MCP_URL
    ? { host_mcp: { type: 'sse' as const, url: `...` } }
    : {}),
```

**问题**：`host_mcp` 只在 `HOST_MCP_URL` 环境变量存在时才注入。这意味着：
- 有 `HOST_MCP_URL` 时 tool 定义包含 4 个 MCP Server（momoclaw_mcp, browser_mcp, host_mcp, context7, github）
- 没有时只有 4 个 MCP Server（momoclaw_mcp, browser_mcp, context7, github）
- 这两种情况下的 tool 列表不同，导致 Prefix Cache 无法跨场景复用

**优化建议**：始终注册 host_mcp（使用固定 URL），只是在运行时根据连接状态决定是否可用。

---

### 问题 3：system prompt 中的动态 session.systemPrompt [中等]

**位置**：[container/src/index.ts#L54](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L54) 和 [container/src/index.ts#L78-L84](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L78-L84)

```typescript
let enhancedSystemPrompt = session.systemPrompt || '';

systemPrompt: enhancedSystemPrompt
    ? { type: 'preset', preset: 'claude_code', append: enhancedSystemPrompt }
    : { type: 'preset', preset: 'claude_code' },
```

**问题**：`session.systemPrompt` 由用户通过 `/system <prompt>` 命令自定义（参见 [sessions.ts#L139-L147](file:///Users/bytedance/workspace/momoclaw/host/src/db/sessions.ts#L139-L147)），每个 session 可能不同。当 `enhancedSystemPrompt` 为空字符串时走 preset-only 路径，非空时走 append 路径。

两种路径的 system prompt 结构完全不同，且不同 session 的 systemPrompt 内容也不同，这会破坏跨 session 的 Prefix Cache 复用。

**优化建议**：
- 如果大多数 session 的 systemPrompt 相同，考虑将其标准化为固定前缀
- 用户自定义部分应放在 system prompt 的末尾而非中间

---

### 问题 4：CLAUDE.md 中指示读取动态日期文件 [中等]

**位置**：[host/workspace/CLAUDE.md#L11](file:///Users/bytedance/workspace/momoclaw/host/workspace/CLAUDE.md#L11)

```markdown
Finish invoke the `memory` skill to retrieve Today's and Yesterday's memory records 
from `/workspace/files/memory/YYYY-MM-DD/MEMORY.md`.
```

**问题**：CLAUDE.md 作为 project settings（通过 `settingSources: ['project', 'user']`）被 Claude Agent SDK 自动加载，成为 system prompt 的一部分。虽然 CLAUDE.md 文件本身是静态的，但它指示 Agent 在每次启动时执行以下动态操作：
1. 读取 `SOUL.md` - 内容可能变化
2. 读取 `USER.md` - 内容可能变化
3. 通过 `memory` skill 读取当天的 `YYYY-MM-DD/MEMORY.md` - 每天不同

这些操作本身不直接影响 system prompt 的前缀缓存（因为是通过 tool call 读取的），但 **Agent 的第一个 tool call 每天都不同**（读取不同日期的文件），导致对话历史的前几条消息每天都不同，破坏 resume 后的 Prefix Cache 延续性。

---

### 问题 5：current-time skill 在启动时主动获取当前时间 [中等]

**位置**：[host/workspace/.claude/skills/current-time/SKILL.md](file:///Users/bytedance/workspace/momoclaw/host/workspace/.claude/skills/current-time/SKILL.md)

```markdown
Also trigger proactively at the start of conversations to ground yourself in the current time.
```

**问题**：这个 skill 的 description 明确指示 Agent "在对话开始时主动触发"来获取当前时间。这意味着：
- 每次新对话开始时，Agent 会执行 `date` 命令
- 返回的时间字符串每秒都不同
- 这条 tool_result 成为对话历史的早期消息之一，**每次不同，直接破坏 Prefix Cache**

**优化建议**：
- 移除 "at the start of conversations" 的指示
- 改为仅在用户询问时间或需要时间信息时才触发
- 或者将当前时间信息注入到 system prompt 的末尾（而非通过 tool call）

---

### 问题 6：SDK resume 机制下的 session 切换问题 [低]

**位置**：[container/src/index.ts#L77](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L77) 和 [chatService.ts#L99-L103](file:///Users/bytedance/workspace/momoclaw/host/src/core/chatService.ts#L99-L103)

```typescript
// container 侧
...(session.claudeSessionId ? { resume: session.claudeSessionId } : {}),

// host 侧
if (result.claudeSessionId) {
    updateSession(session.id, { claudeSessionId: result.claudeSessionId });
}
```

**分析**：项目使用 Claude Agent SDK 的 `resume` 机制来恢复对话上下文，这本身是 Prefix Cache 友好的设计——SDK 会在服务端保持 KV Cache。但存在以下问题：

1. **首次对话无 claudeSessionId**：新 session 首次调用时没有 `resume` 参数，SDK 会创建新的会话。这意味着 system prompt + CLAUDE.md + skills 的整个前缀需要重新计算。
2. **定时任务可能切换 session**：[scheduler.ts#L131-L138](file:///Users/bytedance/workspace/momoclaw/host/src/cron/scheduler.ts#L131-L138) 中，定时任务会动态查找当前活跃 session，如果用户 `/new` 了新 session，任务会写入新 session，导致新 session 的 claudeSessionId 不匹配。

---

### 问题 7：定时任务 prompt 包含动态计数器和上次结果 [低]

**位置**：[scheduler.ts#L146-L165](file:///Users/bytedance/workspace/momoclaw/host/src/cron/scheduler.ts#L146-L165)

```typescript
let executionPrompt = [
    '[Scheduled Task]',
    '这是一个定时触发的独立任务...',
    `任务ID: ${task.id} | 已执行次数: ${task.runCount}`,
].join('\n');

if (task.runCount > 0) {
    const summary = lastLogs[0].output.slice(0, 500);
    executionPrompt += `\n[上次执行结果摘要]: ${summary}`;
}
```

**问题**：每次执行时 `runCount` 递增且 `上次执行结果摘要` 不同，导致相同定时任务的每次执行 prompt 都不同。虽然这是 userInput（在消息末尾），对 system prompt 前缀缓存影响不大，但会影响 resume 后的对话历史 cache。

---

### 问题 8：mcpServers 的 headers 中包含敏感 token [低]

**位置**：[container/src/index.ts#L102-L116](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L102-L116)

```typescript
context7: {
    type: 'http', url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY || '' },
},
github: {
    type: 'http', url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN || ''}` },
},
```

**分析**：API key 和 token 在不同环境/部署中可能不同。如果在不同机器上运行同一 session 的 resume，headers 的变化会导致 cache miss。不过在单机部署场景下这不是问题。

---

### 问题 9：compacted summary 改变 session 状态 [低]

**位置**：[container/src/index.ts#L135-L138](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L135-L138) 和 [chatService.ts#L93-L96](file:///Users/bytedance/workspace/momoclaw/host/src/core/chatService.ts#L93-L96)

```typescript
if (message.type === 'system' && message.subtype === 'compact_boundary') {
    hasCompacted = true;
}
// ...
if (result.compactedSummary) {
    updateSessionSummary(session.id, result.compactedSummary);
}
```

**分析**：当 SDK 检测到上下文过长时会触发 compact（压缩），生成新的 summary 替代旧的对话历史。compact 操作后，旧的 KV Cache 被丢弃，新的 prefix 重新计算。这是 SDK 内置行为，无法避免，但应意识到 compact 后 Prefix Cache 会被完全重置。

---

## 四、Prefix Cache 友好设计的正面发现

项目中也存在一些对 Prefix Cache 友好的设计：

### 4.1 使用 SDK resume 机制（正面）

```typescript
...(session.claudeSessionId ? { resume: session.claudeSessionId } : {})
```

这是最重要的 Cache 友好设计。`resume` 让 SDK 在服务端保持 session 状态，包括 KV Cache，后续请求只需追加新消息而无需重发全部历史。

### 4.2 不传递 messages 数组（正面）

```typescript
messages: [], // 传空数组，因为容器端将使用 resume
```

Host 不再构造和传递 messages 数组，完全依赖 SDK 的 resume 机制，避免了消息重排或丢失导致的 cache miss。

### 4.3 CLAUDE.md 内容本身是静态的（正面）

CLAUDE.md 和所有 skill 文件的内容是静态文本，不包含动态插值（如 `${Date.now()}`）。它们作为 system prompt 的一部分在 session 内保持不变。

### 4.4 MCP tool 定义（大部分）保持稳定顺序（正面）

`momoclaw_mcp`、`browser_mcp`、`context7`、`github` 这些 MCP Server 的注册顺序是固定的（字面量对象属性顺序）。

---

## 五、优化建议汇总

| 优先级 | 问题 | 建议 | 预期效果 |
|--------|------|------|---------|
| **P0** | host_mcp URL 动态参数 | 使用固定 URL，通过 MCP 握手协议传递 context | 同一 session 内的所有请求 tool 定义一致 |
| **P1** | host_mcp 条件注入 | 始终注册所有 MCP Server | 跨场景 tool 定义一致 |
| **P1** | current-time skill 启动时触发 | 移除 "start of conversations" 指令 | 避免每次对话前几条消息不同 |
| **P2** | session.systemPrompt 变化 | 标准化默认 systemPrompt，自定义部分放末尾 | 跨 session 的 prefix 可复用 |
| **P2** | CLAUDE.md 指示读取当日 memory | 将日期文件读取延迟到用户请求时 | 减少对话早期的动态 tool_result |
| **P3** | 定时任务 prompt 动态内容 | 将 runCount/summary 放在 prompt 最末 | 保持 prompt 前缀稳定 |

---

## 六、技术细节补充

### Prefix Cache 的工作方式（Claude 场景）

在 Claude API 中，Prefix Cache 缓存的 KV 计算结果包含以下部分（按顺序）：
1. **System prompt** - 包含 preset(claude_code) + append(用户自定义) + CLAUDE.md + skills
2. **Tool definitions** - 所有 MCP Server 暴露的 tool schema
3. **对话历史** - 按时间顺序的 user/assistant 消息

只要从第 1 条开始的连续前缀保持不变，后续部分即可命中缓存。项目使用 SDK 的 `resume` 机制，意味着 cache 主要由 Anthropic 服务端管理。但上述分析的问题仍然适用——因为 tool definitions 的变化会导致整个 cache 失效。

### 关键代码路径图

```
Host processChat()           →  container.ts runContainerAgent()
  ↓                               ↓
构建 PromptPayload             写 payload.json
        
          
分析完成。让我补充验证几个关键发现。
        
            
toolName: view_files
            
status: success
          
            
filePath: /Users/bytedance/workspace/momoclaw/container/src/index.ts
          

        
            
toolName: view_files
            
status: success
          
            
filePath: /Users/bytedance/workspace/momoclaw/host/workspace/CLAUDE.md
          

        
            
toolName: view_files
            
status: success
          
            
filePath: /Users/bytedance/workspace/momoclaw/host/workspace/.claude/skills/current-time/SKILL.md
          

        
            
toolName: view_files
            
status: success
          
            
filePath: /Users/bytedance/workspace/momoclaw/host/src/cron/scheduler.ts
          
好的，信息已经完整确认。以下是从 **Prefix Cache** 角度对 momoclaw 项目的完整分析。

---

## Prefix Cache 分析报告

### 背景

Prefix Cache 是 Claude/OpenAI 等 LLM API 的优化机制：如果多次请求的 prompt 前缀（system prompt → tool definitions → 对话历史）**完全一致**，服务端可以复用已缓存的 KV 计算结果，**降低延迟和成本**。任何前缀部分的变化都会导致 cache miss，后续所有内容都需要重新计算。

momoclaw 通过 `@anthropic-ai/claude-agent-sdk` 调用 Claude API，使用 `resume` 机制恢复 session，核心调用点在 [container/src/index.ts#L75-L117](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L75-L117)。

---

### P0 严重：host_mcp URL 包含动态查询参数

**位置**：[index.ts#L94-L100](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L94-L100)

```typescript
host_mcp: {
  type: 'sse' as const,
  url: `${process.env.HOST_MCP_URL}?channelType=${channelContext?.type}&channelId=${channelContext?.channelId}&sessionId=${session.id}`,
}
```

URL 中拼接了 `channelType`、`channelId`、`sessionId`，这三个值在不同请求中可能不同。`mcpServers` 配置会被序列化进 API 请求的 tool definitions 部分，**tool definitions 变化 → 整个 Prefix Cache 失效**。

**建议**：使用固定 URL，将 context 信息通过 MCP 握手/消息协议传递，而非 URL 参数。

---

### P1 中等：host_mcp 条件性注入导致 tool 定义不一致

**位置**：[index.ts#L94-L101](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L94-L101)

```typescript
...(process.env.HOST_MCP_URL
  ? { host_mcp: { ... } }
  : {}),
```

有无 `HOST_MCP_URL` 时，tool 列表数量不同（4 vs 5 个 MCP Server），两种场景的 cache 完全不可复用。

**建议**：始终注册 host_mcp（哪怕用占位 URL），运行时再决定是否可用。

---

### P1 中等：current-time skill 在对话开头主动触发

**位置**：[SKILL.md#L8](file:///Users/bytedance/workspace/momoclaw/host/workspace/.claude/skills/current-time/SKILL.md#L8)

```
Also trigger proactively at the start of conversations to ground yourself in the current time.
```

这会导致 Agent 每次新对话时执行 `date` 命令，返回的时间字符串**秒级不同**。这条 tool_result 成为对话历史中的前几条消息，**破坏 resume 后的对话历史前缀缓存**。

**建议**：移除「start of conversations 主动触发」的指示，改为按需触发。或将当前时间注入 system prompt 末尾（不影响前缀）。

---

### P2 中等：CLAUDE.md 指示启动时读取每日 memory 文件

**位置**：[CLAUDE.md#L11](file:///Users/bytedance/workspace/momoclaw/host/workspace/CLAUDE.md#L11)

```
Finish invoke the `memory` skill to retrieve Today's and Yesterday's memory records 
from `/workspace/files/memory/YYYY-MM-DD/MEMORY.md`.
```

每天的日期不同 → Agent 首轮 tool call 的参数（文件路径）和结果都不同 → 对话历史前几条消息每天都变 → resume 后的 Prefix Cache 按天失效。

**建议**：将 memory 读取延迟到用户实际请求时，或在 system prompt 末尾注入当日 memory（避免通过 tool call）。

---

### P2 中等：session.systemPrompt 动态变化

**位置**：[index.ts#L78-L84](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L78-L84)

```typescript
systemPrompt: enhancedSystemPrompt
  ? { type: 'preset', preset: 'claude_code', append: enhancedSystemPrompt }
  : { type: 'preset', preset: 'claude_code' },
```

不同 session 可能有不同的 `systemPrompt`（通过 `/system` 命令设置），甚至有/无 append 走的是两条完全不同的 system prompt 路径。**跨 session 的 Prefix Cache 无法复用**。

**建议**：标准化一个默认 systemPrompt 始终 append（哪怕为空也用 append 模式），自定义部分放在 append 内容的末尾。

---

### P3 低：定时任务 prompt 含动态计数器和上次结果

**位置**：[scheduler.ts#L146-L165](file:///Users/bytedance/workspace/momoclaw/host/src/cron/scheduler.ts#L146-L165)

```typescript
`任务ID: ${task.id} | 已执行次数: ${task.runCount}`,
// ...
executionPrompt += `\n[上次执行结果摘要]: ${summary}`;
```

每次执行 `runCount` 递增，`summary` 内容也不同。虽然作为 userInput 在消息末尾影响较小，但在 resume 场景下会使历史消息链逐步偏离。

---

### 正面设计（做得好的部分）

| 做法 | 位置 | 说明 |
|------|------|------|
| 使用 SDK `resume` 机制 | [L77](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L77) | 最关键的 Cache 友好设计，服务端保持 KV Cache |
| 不传递 messages 数组 | [L173](file:///Users/bytedance/workspace/momoclaw/host/src/cron/scheduler.ts#L173) | 避免消息重排导致 cache miss |
| CLAUDE.md 本身是静态文件 | [CLAUDE.md](file:///Users/bytedance/workspace/momoclaw/host/workspace/CLAUDE.md) | 不含动态插值，作为 system prompt 前缀稳定 |
| MCP Server 注册顺序固定 | [L91-L116](file:///Users/bytedance/workspace/momoclaw/container/src/index.ts#L91-L116) | tool 定义顺序一致（除了条件注入问题） |

---

### 总结

最大的问题是 **host_mcp URL 的动态参数**（P0），它直接导致 tool definitions 每次不同，从根上破坏了 Prefix Cache。其次是 **current-time skill 和 memory skill 的启动触发**（P1/P2），让对话历史的前几条消息每次都不同。建议优先修复 P0 和 P1 问题，预计能显著提升 cache 命中率，降低 API 调用成本和延迟。