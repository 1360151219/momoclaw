# MomoClaw 飞书 SDK 集成

本文档描述 MomoClaw 飞书集成的实现，基于官方 `@larksuiteoapi/node-sdk` SDK。

## 架构对比

### 重构前（自定义实现）
- 手写 WebSocket 连接逻辑
- 手动 token 管理
- 手动 API 请求封装
- 无流式卡片支持

### 重构后（官方 SDK）
- 使用 `@larksuiteoapi/node-sdk` 官方 SDK
- SDK 自动处理 WebSocket 连接和重连
- SDK 自动管理 token 缓存和刷新
- 支持流式卡片更新（CardKit API）
- 类型安全的 API 调用

## 文件结构

```
host/src/feishu/
├── index.ts      # 模块导出
├── types.ts      # 类型定义（保持不变）
├── client.ts     # SDK 客户端封装
├── sender.ts     # 消息发送器（新增流式支持）
├── receiver.ts   # 消息接收解析器
├── gateway.ts    # 主网关（使用 SDK 事件分发）
└── logger.ts     # 日志工具
```

## 核心组件

### 1. Client (`client.ts`)

SDK 客户端工厂函数：

```typescript
// 获取 HTTP 客户端（带缓存）
const client = getHttpClient({
    appId: 'cli_xxx',
    appSecret: 'xxx',
    domain: 'feishu' // 或 'lark'
});

// 获取 WebSocket 客户端
const wsClient = getWsClient(credentials);

// 获取事件分发器
const dispatcher = getEventDispatcher({
    verificationToken: 'xxx',
    encryptKey: 'xxx'
});
```

### 2. Sender (`sender.ts`)

消息发送功能：

```typescript
const sender = new FeishuSender(config);

// 发送普通卡片
await sender.sendCard(chatId, {
    text: 'Hello World',
    thinking: 'optional thinking content'
});

// 发送文本
await sender.sendText(chatId, 'Simple text');

// 添加反应表情
const reactionId = await sender.addReaction(messageId, 'OneSecond');
await sender.removeReaction(messageId, reactionId);

// 流式卡片（用于 AI 回复）
const cardId = await sender.createStreamingCard();
await sender.sendCardByRef(chatId, cardId);
await sender.updateCard(cardId, elementId, content, sequence);
await sender.closeCardStreaming(cardId, sequence);
```

### 3. Gateway (`gateway.ts`)

主网关类：

```typescript
const gateway = new FeishuGateway(config);

// 启动（阻塞直到 stop() 被调用）
await gateway.start({
    onMessage: async (message) => {
        // 处理消息，返回响应
        return { text: 'Response' };
    },
    onStream: async (message, updater) => {
        // 流式响应
        await updater.updateThinking('Thinking...');
        await updater.updateContent('Partial response');
        await updater.appendToolUse('tool_name', { input: 'data' });
        await updater.finalize({ text: 'Final response' });
    }
});

// 停止
gateway.stop();
```

## 使用方法

### 基础用法

```typescript
import { FeishuGateway } from './feishu/index.js';

const gateway = new FeishuGateway({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    domain: 'feishu',
    autoReplyGroups: ['oc_xxx'] // 自动回复的群组
});

await gateway.start({
    onMessage: async (message) => {
        console.log(`Received: ${message.content}`);
        return {
            text: `Echo: ${message.content}`,
            model: 'test',
            elapsedMs: 100
        };
    }
});
```

### 流式响应（AI 场景）

```typescript
await gateway.start({
    onStream: async (message, updater) => {
        // 模拟 AI 流式输出
        await updater.updateThinking('Analyzing...');

        const words = ['Hello', ' ', 'World', '!'];
        for (const word of words) {
            await updater.updateContent(word);
            await new Promise(r => setTimeout(r, 100));
        }

        await updater.finalize({
            text: 'Hello World!',
            model: 'claude-3-sonnet',
            elapsedMs: 500
        });
    }
});
```

## 与 neoclaw 的对比

| 特性 | neoclaw | momoclaw (新) |
|------|---------|---------------|
| SDK | `@larksuiteoapi/node-sdk` | `@larksuiteoapi/node-sdk` |
| WebSocket | SDK 内置 | SDK 内置 |
| Token 管理 | SDK 自动 | SDK 自动 |
| 流式卡片 | ✅ | ✅ |
| 交互式表单 | ✅ | （可扩展） |
| 代码复杂度 | 高（17560行 gateway） | 低（~400行 gateway） |
| 抽象层级 | 多层抽象 | 简洁直接 |
| 学习曲线 | 陡峭 | 平缓 |

## 从 neoclaw 吸收的优点

1. **官方 SDK 使用**：使用 `@larksuiteoapi/node-sdk` 而非手写 HTTP
2. **流式卡片更新**：支持 CardKit API 的流式更新
3. **事件分发器模式**：使用 SDK 的 EventDispatcher 处理消息
4. **反应表情管理**：⏳ 处理中表情
5. **消息去重**：持久化的消息去重机制

## 摒弃的复杂性

1. **过度抽象**：neoclaw 的 gateway.ts 过于复杂（17560行）
2. **多 gateway 支持**：目前只聚焦飞书，保持简单
3. **复杂的 Agent 系统**：MomoClaw 保持轻量级
4. **Daemon 模式**：简化进程管理

## 配置

```typescript
interface FeishuConfig {
    appId: string;              // 应用 ID
    appSecret: string;          // 应用密钥
    encryptKey?: string;        // 加密密钥（可选）
    verificationToken?: string; // 验证令牌（可选）
    domain?: 'feishu' | 'lark'; // 域名
    autoReplyGroups?: string[]; // 自动回复群组 ID 列表
}
```

## 环境变量

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=feishu
```

## 依赖

```json
{
    "dependencies": {
        "@larksuiteoapi/node-sdk": "^1.59.0"
    }
}
```


