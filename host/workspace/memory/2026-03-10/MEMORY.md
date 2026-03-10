# Daily Memory - 2026-03-10

## Important Facts
- MomoClaw 项目使用 TypeScript + Node.js + Docker
- 飞书渠道是核心功能之一
- 技术栈包括：SQLite (persistence), Claude Agent SDK, Lark SDK

## Decisions Made
- **飞书命令统一处理**: 所有命令 (`/list`, `/new`, `/clear`) 统一在 `gateway.ts` 的 `handleCommand` 中处理，而非分散在 `chat/feishu.ts`。原因：职责分离更清晰，gateway 负责协议层，chat 负责对话逻辑
- **Lark SDK 优先**: 将 `sender.ts` 中的直接 HTTP 调用改为使用 Lark SDK 官方 API。原因：代码更简洁，类型安全，易维护
- **Sequence 并发问题解决方案**: 使用 FIFO update queue 模式解决 `sequence number compare failed` 错误。原因：sequence 是乐观锁机制，必须严格顺序递增，并发操作会导致冲突

## Progress
- [x] 重构飞书命令处理逻辑，统一在 gateway.ts
- [x] 实现 `/list` 命令：列出所有 session，标注当前活跃
- [x] 实现 `/new` 命令：创建带时间戳的新 session
- [x] 修复 `/clear` 命令：真正操作数据库清除消息
- [x] FeishuSender SDK 化改造：updateCard, appendCardElements, removeCardElement, closeCardStreaming
- [x] 修复 sequence 并发冲突问题，添加 update queue 机制

## Code Patterns
```typescript
// 更新队列 - 保证 sequence 严格顺序递增
const updateQueue: Array<() => Promise<void>> = [];
let isProcessing = false;

const enqueueUpdate = (updateFn: () => Promise<void>): Promise<void> => {
  return new Promise((resolve, reject) => {
    updateQueue.push(async () => {
      try {
        await updateFn();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    processQueue();
  });
};
```

## Notes for Tomorrow
- [ ] 观察飞书渠道运行稳定性
- [ ] 考虑是否需要更多 session 管理功能
