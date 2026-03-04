# Nanobot 记忆系统技术报告

## 项目概述

**Nanobot** 是一个超轻量级个人 AI 助手，由 HKUDS 实验室开发，灵感来源于 OpenClaw。项目核心代码仅约 **4,000 行**（相比 Clawdbot 的 43 万行代码，减少了 99%）。

### 核心特性
- 支持多平台：Telegram、Discord、WhatsApp、飞书、钉钉、Slack、Email、QQ、Matrix
- 多 LLM 提供商：OpenRouter、Anthropic、OpenAI、DeepSeek、Gemini 等
- MCP (Model Context Protocol) 支持
- Agent 社交网络平台连接

---

## 1. 记忆系统架构设计

### 1.1 双层记忆模型

Nanobot 采用创新的**双层记忆架构**：

```
┌─────────────────────────────────────────────────────────────────┐
│                    长期记忆层 (Long-term)                         │
│                  memory/MEMORY.md                               │
│        (核心事实、偏好设置、项目上下文 - 始终加载)                   │
├─────────────────────────────────────────────────────────────────┤
│                    历史记录层 (History)                           │
│                  memory/HISTORY.md                              │
│     (追加式事件日志 - 不自动加载，通过 grep 搜索)                   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 记忆层级对比

| 层级 | 文件 | 加载策略 | 用途 | 更新方式 |
|------|------|----------|------|----------|
| **Long-term** | `MEMORY.md` | 始终加载到上下文 | 用户偏好、项目信息、关系 | 立即写入 |
| **History** | `HISTORY.md` | 按需 grep 搜索 | 时间线事件、对话摘要 | 自动归档 |

---

## 2. 记忆存储实现

### 2.1 MemoryStore 核心类

```python
# nanobot/agent/memory.py
class MemoryStore:
    """Two-layer memory: MEMORY.md (long-term facts) + HISTORY.md (grep-searchable log)."""

    def __init__(self, workspace: Path):
        self.memory_dir = ensure_dir(workspace / "memory")
        self.memory_file = self.memory_dir / "MEMORY.md"
        self.history_file = self.memory_dir / "HISTORY.md"
```

### 2.2 记忆文件操作

```python
def read_long_term(self) -> str:
    """读取长期记忆文件"""
    if self.memory_file.exists():
        return self.memory_file.read_text(encoding="utf-8")
    return ""

def write_long_term(self, content: str) -> None:
    """写入长期记忆文件"""
    self.memory_file.write_text(content, encoding="utf-8")

def append_history(self, entry: str) -> None:
    """追加历史记录（追加模式）"""
    with open(self.history_file, "a", encoding="utf-8") as f:
        f.write(entry.rstrip() + "\n\n")
```

### 2.3 默认 MEMORY.md 模板

```markdown
# Long-term Memory

This file stores important information that should persist across sessions.

## User Information

(Important facts about the user)

## Preferences

(User preferences learned over time)

## Project Context

(Information about ongoing projects)

## Important Notes

(Things to remember)
```

---

## 3. 记忆整合 (Consolidation) 机制

### 3.1 自动触发条件

```python
# nanobot/agent/loop.py:396-412
unconsolidated = len(session.messages) - session.last_consolidated
if (unconsolidated >= self.memory_window and session.key not in self._consolidating):
    self._consolidating.add(session.key)
    lock = self._consolidation_locks.setdefault(session.key, asyncio.Lock())

    async def _consolidate_and_unlock():
        try:
            async with lock:
                await self._consolidate_memory(session)
        finally:
            self._consolidating.discard(session.key)

    _task = asyncio.create_task(_consolidate_and_unlock())
```

### 3.2 LLM 驱动的记忆整合

```python
# nanobot/agent/memory.py:69-150
async def consolidate(
    self,
    session: Session,
    provider: LLMProvider,
    model: str,
    *,
    archive_all: bool = False,
    memory_window: int = 50,
) -> bool:
    """通过 LLM 工具调用将旧消息整合到 MEMORY.md + HISTORY.md"""

    # 准备待整合的消息
    old_messages = session.messages[session.last_consolidated:-keep_count]

    # 构建提示词
    prompt = f"""Process this conversation and call the save_memory tool with your consolidation.

## Current Long-term Memory
{current_memory or "(empty)"}

## Conversation to Process
{chr(10).join(lines)}"""

    # 调用 LLM 进行整合
    response = await provider.chat(
        messages=[...],
        tools=_SAVE_MEMORY_TOOL,  # 使用工具调用模式
        model=model,
    )
```

### 3.3 save_memory 工具定义

```python
_SAVE_MEMORY_TOOL = [
    {
        "type": "function",
        "function": {
            "name": "save_memory",
            "description": "Save the memory consolidation result to persistent storage.",
            "parameters": {
                "type": "object",
                "properties": {
                    "history_entry": {
                        "type": "string",
                        "description": "A paragraph summarizing key events/decisions/topics. "
                                       "Start with [YYYY-MM-DD HH:MM]. Include detail useful for grep search.",
                    },
                    "memory_update": {
                        "type": "string",
                        "description": "Full updated long-term memory as markdown. Include all existing "
                                       "facts plus new ones. Return unchanged if nothing new.",
                    },
                },
                "required": ["history_entry", "memory_update"],
            },
        },
    }
]
```

---

## 4. 会话管理系统

### 4.1 Session 数据模型

```python
# nanobot/session/manager.py:15-32
@dataclass
class Session:
    """A conversation session.

    Stores messages in JSONL format for easy reading and persistence.
    Important: Messages are append-only for LLM cache efficiency.
    """

    key: str  # channel:chat_id
    messages: list[dict[str, Any]] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    metadata: dict[str, Any] = field(default_factory=dict)
    last_consolidated: int = 0  # 已整合到文件的消息数
```

### 4.2 Session 持久化格式 (JSONL)

```jsonl
{"_type": "metadata", "key": "telegram:123456", "created_at": "2026-01-15T10:00:00", "last_consolidated": 50}
{"role": "user", "content": "你好", "timestamp": "2026-01-15T10:00:00"}
{"role": "assistant", "content": "你好！有什么可以帮助你的？", "timestamp": "2026-01-15T10:00:01"}
```

### 4.3 历史消息获取策略

```python
def get_history(self, max_messages: int = 500) -> list[dict[str, Any]]:
    """Return unconsolidated messages for LLM input, aligned to a user turn."""
    unconsolidated = self.messages[self.last_consolidated:]
    sliced = unconsolidated[-max_messages:]

    # 丢弃开头的非用户消息，避免孤立的 tool_result 块
    for i, m in enumerate(sliced):
        if m.get("role") == "user":
            sliced = sliced[i:]
            break
```

---

## 5. 上下文构建系统

### 5.1 ContextBuilder 架构

```python
# nanobot/agent/context.py:15-24
class ContextBuilder:
    """Builds the context (system prompt + messages) for the agent."""

    BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md"]

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.memory = MemoryStore(workspace)
        self.skills = SkillsLoader(workspace)
```

### 5.2 系统提示词构建流程

```python
def build_system_prompt(self, skill_names: list[str] | None = None) -> str:
    """Build the system prompt from identity, bootstrap files, memory, and skills."""
    parts = [self._get_identity()]

    # 1. 加载引导文件
    bootstrap = self._load_bootstrap_files()
    if bootstrap:
        parts.append(bootstrap)

    # 2. 加载长期记忆
    memory = self.memory.get_memory_context()
    if memory:
        parts.append(f"# Memory\n\n{memory}")

    # 3. 加载常驻技能
    always_skills = self.skills.get_always_skills()
    if always_skills:
        always_content = self.skills.load_skills_for_context(always_skills)
        parts.append(f"# Active Skills\n\n{always_content}")

    return "\n\n---\n\n".join(parts)
```

### 5.3 引导文件优先级

| 文件 | 用途 |
|------|------|
| `AGENTS.md` | Agent 行为定义 |
| `SOUL.md` | 核心人格/灵魂定义 |
| `USER.md` | 用户信息 |
| `TOOLS.md` | 工具使用说明 |
| `IDENTITY.md` | 身份定义 |

---

## 6. 技能系统 (Skills)

### 6.1 技能加载器

```python
# nanobot/agent/skills.py:13-25
class SkillsLoader:
    """Loader for agent skills.

    Skills are markdown files (SKILL.md) that teach the agent how to use
    specific tools or perform certain tasks.
    """

    def __init__(self, workspace: Path, builtin_skills_dir: Path | None = None):
        self.workspace = workspace
        self.workspace_skills = workspace / "skills"
        self.builtin_skills = builtin_skills_dir or BUILTIN_SKILLS_DIR
```

### 6.2 技能优先级

1. **Workspace Skills** (最高优先级) - 用户自定义
2. **Built-in Skills** - 系统内置

### 6.3 Memory Skill 示例

```markdown
---
name: memory
description: Two-layer memory system with grep-based recall.
always: true
---

# Memory

## Structure

- `memory/MEMORY.md` — Long-term facts. Always loaded into your context.
- `memory/HISTORY.md` — Append-only event log. NOT loaded into context. Search it with grep.

## Search Past Events

```bash
grep -i "keyword" memory/HISTORY.md
```

## Auto-consolidation

Old conversations are automatically summarized when the session grows large.
```

---

## 7. 关键设计决策

### 7.1 为什么选择双层记忆？

| 设计决策 | 理由 |
|----------|------|
| **不加载整个历史** | 避免上下文窗口膨胀 |
| **grep 搜索历史** | 按需检索，精确高效 |
| **LLM 驱动整合** | 智能提取事实，自然语言理解 |
| **追加式历史** | 高性能写入，文件安全 |

### 7.2 记忆 vs Session 分离

```
Session (内存)
├── 当前对话的完整消息
├── 用于 LLM 多轮交互
└── 定期整合到文件

Memory (文件)
├── MEMORY.md - 核心事实
├── HISTORY.md - 时间线
└── 跨 Session 持久化
```

### 7.3 整合触发策略

```
记忆窗口: 100 条消息
触发条件: 未整合消息 >= 100
保留消息: 50 条 (最近)
整合消息: 50 条 (旧消息)
```

---

## 8. 核心文件清单

| 文件路径 | 功能描述 |
|----------|----------|
| `nanobot/agent/memory.py` | 双层记忆系统实现 |
| `nanobot/agent/context.py` | 上下文构建器 |
| `nanobot/agent/loop.py` | Agent 主循环，整合触发 |
| `nanobot/session/manager.py` | 会话管理 |
| `nanobot/agent/skills.py` | 技能加载器 |
| `nanobot/templates/memory/MEMORY.md` | 记忆文件模板 |
| `nanobot/skills/memory/SKILL.md` | 记忆系统技能说明 |

---

## 9. 与 NanoClaw 记忆系统对比

| 特性 | Nanobot | NanoClaw |
|------|---------|----------|
| **核心代码量** | ~4,000 行 | ~600 行 |
| **记忆架构** | 双层 (Memory + History) | 三层 (Global + Group + Files) |
| **整合机制** | LLM 工具调用 | PreCompact Hook |
| **历史搜索** | grep | 文件浏览 |
| **多群组** | Session 隔离 | 容器隔离 |
| **持久化** | JSONL + Markdown | SQLite + Markdown |
| **技能系统** | 动态加载 SKILL.md | 静态 CLAUDE.md |

---

## 10. 总结

Nanobot 的记忆系统设计体现了**极简而高效**的理念：

1. **双层架构**：区分"需要记住的事实"和"可以搜索的历史"
2. **智能整合**：利用 LLM 自动提取关键信息，减少人工干预
3. **高性能**：追加式写入，按需加载，避免 I/O 瓶颈
4. **可搜索历史**：通过 grep 实现精确检索，而非加载全部内容
5. **技能驱动**：Memory Skill 教授 Agent 如何管理自己的记忆

这种设计在保持代码简洁的同时，提供了企业级的记忆管理能力，是轻量级 AI 助手架构的典范。

---

*报告生成时间: 2026-03-03*
*调研项目: Nanobot (github.com/HKUDS/nanobot)*
