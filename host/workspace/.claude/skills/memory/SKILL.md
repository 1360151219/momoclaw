---
name: "memory"
description: "智能记忆管理 skill。当用户说'记住这个'、'保存到记忆'、'更新记忆'、'帮我记着'、'别忘了'、'记一下'时触发。更重要的是，当对话中出现以下信息时要**自动识别并保存**：1)用户偏好('我喜欢...'/'以后请...')2)重要决策(技术选型/架构决定)3)待办事项('明天要做...')4)关键问题及解决方案5)项目配置/路径。自动保存到每日记忆文件(/workspace/files/memory/YYYY-MM-DD/MEMORY.md)，并在新会话开始时自动注入上下文。**遇到重要信息时主动保存，不要等待用户指令。**"
triggers:
  - "保存到记忆"
  - "记住这个"
  - "记录一下"
  - "更新记忆"
  - "查看记忆"
  - "读取记忆"
  - "搜索记忆"
  - "帮我记着"
  - "别忘了"
  - "记一下"
  - "写下来"
  - "存起来"
---

# Memory Skill - 智能记忆管理

让 Agent 具备长期记忆能力，自动保存重要信息并在需要时回顾历史上下文。

## 记忆文件结构

**今日记忆**: `/workspace/files/memory/YYYY-MM-DD/MEMORY.md`

### 标准模板

```markdown
# Daily Memory

## Important Facts
- 关键信息：用户偏好、项目状态等

## Decisions Made
- **决策标题**: 决策内容及原因

## Progress
- [x] 已完成的工作

## Notes for Tomorrow
- [ ] 待办事项
```

## 何时保存记忆（决策流程）

```
用户是否明确说"记住"/"保存"/"记录"?
├─ 是 → 立即保存
└─ 否 → 检查是否有以下信号：

  - "我喜欢..."/"以后请..."/"总是..." → 保存偏好
  - "决定用..."/"选型..."/"用...而不是..." → 保存决策
  - "明天要做..."/"别忘了..." → 保存待办
  - "搞定了"/"解决了"/"原因是..." → 保存成果/方案
  - 涉及具体路径/配置/参数 → 保存关键值
```

### 优先级

**🔴 必须保存**：
- 用户明确指令（"记住这个"）
- 重要决策及原因
- 用户偏好/习惯
- 待办事项/目标

**🟡 建议保存**：
- 关键问题及解决方案
- 重要配置/路径
- 项目里程碑

**🟢 跳过**：
- 临时查询/回答
- 常识信息
- 纯技术文档可查的内容

## 如何保存记忆

### 标准流程（Read → Modify → Write）

```typescript
// 1. 读取今日记忆
const today = new Date().toISOString().split('T')[0];
const current = await Read({
  file_path: `/workspace/files/memory/${today}/MEMORY.md`
});

// 2. 在适当位置追加内容
// 偏好 → Important Facts
// 决策 → Decisions Made
// 任务 → Notes for Tomorrow
// 完成 → Progress

// 3. 写回文件
await Write({
  file_path: `/workspace/files/memory/${today}/MEMORY.md`,
  content: updated
});
```

### 格式规范

**偏好**：`- 偏好描述（如：偏好 4 空格缩进）`
**决策**：`- **标题**: 决策内容 + 原因`
**任务**：`- [ ] 任务描述`
**完成**：`- [x] 完成内容`

## 搜索历史记忆

```typescript
// 搜索所有记忆文件
await Grep({
  pattern: "关键词",
  path: "/workspace/files/memory",
  output_mode: "content"
});

// 列出所有记忆日期
await Glob({
  pattern: "/workspace/files/memory/*/MEMORY.md"
});
```

## 自动记忆注入

系统会在每个新会话开始时自动读取今日和昨日记忆，注入到 `## Memory Context` 部分。

**Agent 应该**：
- 自然融入对话，不提及"根据记忆..."
- 结合记忆内容回应用户

## 最佳实践

✅ **简洁具体**："偏好 4 空格缩进"
✅ **可执行**："明天完成 Docker 优化"
✅ **有上下文**："项目使用 MomoClaw 架构"

❌ 避免：笼统、临时、重复、过长的内容

## 主动触发场景

| 场景 | 信号 | 保存内容 |
|------|------|----------|
| 决策 | "决定..."/"用...而不是..." | 决策 + 原因 |
| 纠正 | "不对"/"应该是" | 正确信息 |
| 完成 | "搞定了"/"测试通过" | 成果 |
| 偏好 | "我喜欢..."/"下次..." | 具体偏好 |

## 工具速查

| 操作 | 工具 | 参数 |
|------|------|------|
| 读取 | `Read` | `/workspace/files/memory/YYYY-MM-DD/MEMORY.md` |
| 搜索 | `Grep` | `pattern`, `path: /workspace/files/memory` |
| 列出 | `Glob` | `pattern: /workspace/files/memory/*/MEMORY.md` |
