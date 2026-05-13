# MomoClaw 每日主动问候功能 —— 技术方案

## 一、设计理念

**零代码改动，纯配置实现。**

MomoClaw 已经具备完整的基础设施：Skill 系统、定时任务（CronService）、多渠道推送（ChannelRegistry）、记忆系统、article-fetcher / browser MCP。

本方案的核心思路：**将问候逻辑封装为一个 Skill，然后通过现有的 `schedule_task` MCP 工具注册一个每日定时任务来触发它。**

不需要写任何 TypeScript 代码，只需要：
1. 新增一个 Skill 文件（`daily-greeting/SKILL.md`）
2. 通过对话或 idle-sop 注册一个 cron 定时任务

---

## 二、核心体验

> 早上打开飞书/微信，收到 MomoClaw 发来的一条温暖且有信息量的消息，像一位了解你的朋友，既关心你的状态，又带来你关心的新鲜事。

示例消息：

```
☀️ 早上好！昨晚你提到最近在研究 Rust 的异步编程，我找到一篇不错的文章推荐给你：
《Tokio 1.0 深度指南》—— 刚好覆盖了你昨天问的 select! 宏的用法。

📰 今天的科技快讯：
• OpenAI 发布 GPT-5，推理能力大幅提升
• Rust 1.82 稳定版发布，新增 async closure 支持

记得你说这周五有个技术分享要准备，加油！有什么需要帮忙的随时找我 💪
```

---

## 三、架构总览

```
┌─────────────────────────────────────────────────┐
│            CronService（已有，零改动）             │
│           每天 cron 触发定时任务                   │
└────────────────────┬────────────────────────────┘
                     │ prompt: "invoke daily-greeting skill"
                     ▼
┌─────────────────────────────────────────────────┐
│            Container（Claude Agent）              │
│                                                 │
│  1. 识别 prompt → 调用 daily-greeting Skill      │
│  2. Skill 指导 Claude 执行：                      │
│     ├─ 读取 SOUL.md / USER.md / 近期记忆          │
│     ├─ 用 article-fetcher 抓取用户感兴趣的新闻    │
│     ├─ 综合生成个性化问候                         │
│     └─ 输出问候内容                              │
│                                                 │
└────────────────────┬────────────────────────────┘
                     │ 输出结果
                     ▼
┌─────────────────────────────────────────────────┐
│         ChannelRegistry（已有，零改动）            │
│  CronService 自动将结果推送到对应渠道              │
│  ┌──────┐  ┌──────┐  ┌──────────┐               │
│  │ 飞书  │  │ 微信  │  │ Terminal │               │
│  └──────┘  └──────┘  └──────────┘               │
└─────────────────────────────────────────────────┘
```

**全链路复用已有组件，零代码改动：**

| 组件 | 作用 | 是否改动 |
|------|------|---------|
| CronService + scheduled_tasks | 定时触发 | 否 |
| Container (Claude Agent) | 执行 Skill、生成内容 | 否 |
| article-fetcher MCP | 抓取新闻 | 否 |
| browser MCP | 降级抓取动态页面 | 否 |
| 记忆系统 (SOUL/USER/daily) | 提供用户上下文 | 否 |
| ChannelRegistry | 推送结果到飞书/微信 | 否 |

---

## 四、Skill 设计

### 4.1 文件位置

```
host/workspace/.claude/skills/daily-greeting/SKILL.md
```

### 4.2 Skill 内容

```markdown
---
name: "daily-greeting"
description: >
  每日主动问候 Skill。当定时任务触发或用户要求发送问候时调用。
  综合用户记忆、近期对话、兴趣标签和当日新闻，生成一条个性化的问候消息。
---

# Daily Greeting Skill

向用户发送一条融合记忆、近况和新闻的个性化每日问候。

---

## 执行流程

### Step 1: 信息收集

依次读取以下文件，构建用户画像：

1. **读取 `memory/SOUL.md`** — 确认自己的人格和语气风格
2. **读取 `memory/USER.md`** — 获取用户偏好、兴趣标签、近期关注的事项
3. **读取近 3 天的记忆文件** — `memory/YYYY-MM-DD.md`（今天、昨天、前天），了解近期对话亮点、待办事项、用户提到的计划

从以上信息中提取：
- 用户的兴趣领域（技术方向、关注的公司/产品、生活爱好等）
- 近期的重要事项（即将到来的会议、截止日期、计划等）
- 未完成的待办或用户上次提到的话题
- 用户的语气偏好（如果有记录的话）

### Step 2: 新闻抓取

根据 Step 1 中获取的用户兴趣标签，使用 `article-fetcher` 工具抓取相关新闻：

**推荐新闻源（根据用户兴趣选择 2-3 个）：**
- 技术类：Hacker News (https://news.ycombinator.com/best)、GitHub Trending (https://github.com/trending)
- 中文科技：36Kr (https://36kr.com/hot-list/catalog)、少数派 (https://sspai.com)
- AI 领域：AI News (https://buttondown.com/ainews/archive)
- 通用：可根据 USER.md 中的兴趣自由选择合适的信息源

**抓取规则：**
- 每个源最多取 5 条标题
- 根据用户兴趣筛选出最相关的 **2-3 条**
- 如果 article-fetcher 失败，降级使用 browser 工具
- 如果所有抓取都失败，跳过新闻部分，仅发送基于记忆的问候（不要因此不发问候）

### Step 3: 内容生成

综合以上信息，生成一条问候消息。

**内容结构：**
1. **开头** — 个性化问候（结合日期/星期、用户近况，不要千篇一律的"早上好"）
2. **中间** — 新闻/资讯精选（2-3 条，每条附一句个性化点评，不要简单转述标题）
3. **结尾** — 温暖收尾（如果知道用户近期有什么安排，自然地提到并鼓励）

**语气要求：**
- 像一个了解你的朋友在聊天，不像机器人在播报
- 参考 SOUL.md 中的人格设定来决定语气
- 自然、温暖、有趣，可以适当幽默
- 如果用户近期心情不太好（从记忆中判断），语气更加温柔体贴

**格式要求：**
- 总长度控制在 **200-500 字**
- 可以使用 emoji 但不要过多（3-5 个）
- 新闻部分用列表格式，清晰易读
- 不要使用 markdown 标题语法（#），因为推送到飞书/微信后是纯消息

### Step 4: 输出

直接输出生成的问候消息文本。不要加任何 meta 说明（如"以下是为你生成的问候"），直接就是要发给用户的内容本身。

---

## 注意事项

- **不要编造新闻**：如果抓取不到，就不写新闻部分，不要虚构任何信息
- **不要重复**：如果记得昨天问候过的内容，今天要有所不同
- **尊重隐私**：不要在问候中提及用户可能不想被提醒的敏感话题
- **简洁优先**：宁可精简也不要冗长，用户想看的是一条有温度的消息，不是一篇文章
```

---

## 五、定时任务注册

### 5.1 注册方式

通过对话直接让 MomoClaw 自己注册（最简单的方式）：

> 用户对 MomoClaw 说：
> "帮我设置一个每天早上 8:30 的定时任务，调用 daily-greeting skill 给我发一条每日问候。"

MomoClaw 会通过 `schedule_task` MCP 工具自动创建：

```
mcp__momoclaw_mcp__schedule_task({
  prompt: "请调用 daily-greeting skill，为用户生成并发送今天的每日问候。",
  scheduleType: "cron",
  scheduleValue: "30 8 * * *"
})
```

### 5.2 也可以通过 idle-sop 自动注册

在 idle-sop 的 Phase 3（自主任务调度）中，如果检测到用户表达过"希望每天收到问候"的意愿，自动注册这个定时任务。这完全符合 idle-sop 现有的设计逻辑。

### 5.3 执行链路

```
CronService 10s 轮询
    │
    ├─ 发现 "30 8 * * *" 到期
    │
    ├─ 取出 prompt: "请调用 daily-greeting skill..."
    │
    ├─ 构建 PromptPayload → docker exec 容器
    │
    ├─ Claude Agent 识别 prompt → 调用 daily-greeting Skill
    │   ├─ 读取记忆文件
    │   ├─ 调用 article-fetcher 抓新闻
    │   ├─ 生成问候内容
    │   └─ 返回文本结果
    │
    ├─ CronService 收到结果 → addMessage() 写入消息表
    │
    └─ channelRegistry.sendMessage() → 推送到飞书/微信
```

这条链路中 **每一环都是已有代码**，我们只提供了一个 Skill 文件来指导 Claude 的行为。

---

## 六、用户兴趣标签维护

### 6.1 存储位置

直接在 `memory/USER.md` 中维护，由 AI 在日常对话中自动更新。

建议在 USER.md 中增加一个 Interest Tags 区域：

```markdown
**Interest Tags**
Tech: Rust, TypeScript, AI/LLM, distributed systems
News: tech, opensource, AI product launches
Life: coffee, running, Japanese cuisine
Companies: OpenAI, Anthropic, ByteDance
```

### 6.2 自动维护

不需要任何额外机制。现有的 `memory` Skill 已经会在对话中检测用户偏好并保存。只需在 daily-greeting Skill 中提到"从 USER.md 读取兴趣标签"即可。

如果希望更主动地维护，可以在 SOUL.md 中加一句提示：

```
在对话中发现用户提到新的兴趣领域时，使用 memory skill 更新 USER.md 的 Interest Tags 区域。
```

---

## 七、进阶优化（可选，无需写代码）

以下优化全部可以通过 **修改 Skill 文件内容** 或 **调整定时任务 prompt** 来实现：

### 7.1 节日/特殊日期问候

在 Skill 中增加指令：

```
如果今天是特殊日期（节假日、用户生日等），在问候中融入节日元素。
用户的生日等信息可以从 USER.md 中获取。
```

### 7.2 天气信息

在 Skill 中增加指令：

```
如果知道用户所在城市（从 USER.md 获取），可以使用 web search 查询当天天气，融入问候中。
```

### 7.3 问候风格迭代

直接编辑 Skill 文件中的"语气要求"部分即可。例如：
- 想要更正式 → 修改语气描述
- 想要更简短 → 修改字数限制
- 想要加入特定栏目 → 在内容结构中新增

### 7.4 多时段问候

注册多个定时任务，使用不同的 prompt：

```
早上 8:30 — "调用 daily-greeting skill，生成早间问候，重点推送新闻资讯。"
晚上 22:00 — "调用 daily-greeting skill，生成晚间问候，重点回顾今天的对话和进展，提醒明天的安排。"
```

### 7.5 防打扰

直接在定时任务的 prompt 中加入条件判断指令：

```
"调用 daily-greeting skill。但如果你发现最近一条用户消息距现在不到 10 分钟，
说明用户正在活跃对话中，此时只需简短打个招呼（一句话即可），不要发完整的问候。"
```

---

## 八、实现步骤

**总共只需要做 2 件事：**

### Step 1: 创建 Skill 文件

将第四节的 Skill 内容写入：

```
host/workspace/.claude/skills/daily-greeting/SKILL.md
```

### Step 2: 注册定时任务

对 MomoClaw 说一句话即可：

> "帮我创建一个每天早上 8:30 的定时任务，prompt 是：请调用 daily-greeting skill，为用户生成并发送今天的每日问候。"

**完成。** 不需要改任何代码、不需要加数据库表、不需要改配置文件。

---

## 九、技术风险与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| 新闻抓取超时/失败 | 中 | Skill 中已指定降级策略：跳过新闻，仅发记忆问候 |
| Claude 未正确识别 Skill | 低 | prompt 中明确写"调用 daily-greeting skill"即可 |
| 问候内容质量波动 | 低 | 迭代 Skill 文件的 prompt 指令即可优化 |
| 容器冷启动延迟 | 中 | 可配合已有的容器保活机制；延迟几分钟不影响体验 |
| API 成本 | 低 | 每用户每天仅 1 次调用 |

---

## 十、总结

| 对比项 | 写代码方案 | Skill + 定时任务方案 |
|-------|----------|-------------------|
| 新增代码 | ~200-300 行 TypeScript | **0 行** |
| 新增文件 | greeting.ts + 配置文件 | **1 个 SKILL.md** |
| 数据库改动 | 新增 greeting_preferences 表 | **无** |
| 部署方式 | 需要重新构建部署 | **放入文件 + 说句话注册任务** |
| 可调整性 | 改代码重部署 | **直接编辑 SKILL.md** |
| 扩展性 | 写更多代码 | **改 prompt 文字** |

本方案的哲学：**MomoClaw 已经是一个足够强大的 AI Agent 系统，问候只是它能力的一种应用场景，不需要为此写专门的代码。** 把"做什么"告诉 AI（Skill），让系统在合适的时间触发它（CronService），就够了。
