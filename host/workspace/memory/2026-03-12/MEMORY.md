# Daily Memory - 2026-03-12

## Code Review - Project Structure Analysis

**Status**: Review completed, pending refactoring implementation.

### Issues Identified

**1. container.ts - Severe Responsibility Bleed** ⚠️
- Current: Docker lifecycle + streaming + **260+ lines of cron handling** + direct DB access
- Problem: `handleCronActions()` should NOT be in container management module
- Impact: Forms tight coupling between container, db, and cron modules

**2. chat/index.ts - Mixed Layer Responsibilities**
- CLI interaction (presentation layer) mixed with business logic
- `processChat()` surrounded by CLI-specific code, hard to test independently
- Different code paths for Feishu vs CLI

**3. cron.ts - Scheduling vs Execution Not Separated**
- `CronService` mixes `start/stop/checkAndRunTasks` (scheduling) with `executeTask` (execution)
- `executeTask` directly calls `runContainerAgent` and pushes to channels

**4. Feishu Module Abstraction Confusion**
- `feishu/` (SDK layer) boundary with `channels/feishuHandler.ts` unclear
- `chat/feishu.ts` (startup logic) location questionable

**5. types.ts - Low Cohesion**
- Single file contains: domain models, config types, infrastructure types, cron types, channel types

**6. Orphaned File**
- `summarization.ts` - appears unused, possibly legacy

### Refactoring Plan

**Priority P0: Fix container.ts Cron Bleed**
- Create `cron/executor.ts` - extract `handleCronActions` and `executeTask`
- `container.ts` keeps only: `ContainerRunner` interface, `checkDockerAvailable()`, `buildContainerImage()`

**Priority P1: Separate CLI from Business Logic**
- Create `core/chatService.ts` - extract `processChat` as pure business logic
- `chat/index.ts` keeps only CLI interaction (readline, command parsing)
- Enable independent testing of chat logic

**Priority P2: Split Cron Responsibilities**
- `cron/index.ts` - scheduler only (start/stop/check)
- `cron/executor.ts` - task execution logic
- Inject dependencies: `ContainerRunner`, `ChannelRegistry`, `DbClient`

**Priority P3: Clarify Feishu Abstractions**
- Option A: Merge `channels/feishuHandler.ts` into `feishu/` as adapter layer
- Option B: Keep `feishu/` as pure SDK, move all integration to `channels/`

**Priority P4: Split types.ts by Domain**
```
types/
├── domain.ts      # Session, Message
├── config.ts      # Config, ApiConfig
├── infra.ts       # ContainerResult, ToolCall
├── cron.ts        # CronAction, ScheduledTask
└── channel.ts     # ChannelType, ChannelHandler
```

### Option A: Minimal Changes (Recommended)
```
host/src/
├── core/                    # NEW: Core business logic
│   ├── chatService.ts       # Extract from chat/index.ts
│   └── taskExecutor.ts      # Extract from cron.ts
├── channels/
├── chat/                    # Keep CLI interaction only
├── db/
├── feishu/
├── cron/                    # RENAME from cron.ts
│   ├── index.ts             # Scheduler
│   └── executor.ts          # Task execution
├── container.ts             # Remove cron handling
└── ...
```

### Option B: Full Layered Architecture (Long-term)
```
host/src/
├── domain/                  # Entities, value objects
├── application/             # Use cases, workflows
├── infrastructure/          # DB, container, external APIs
├── interfaces/              # CLI, HTTP adapters
└── config.ts
```

### Progress Update

**P0 Completed**: Extracted cron executor from container.ts
- Created `cron/executor.ts` - 210 lines of cron action handling
- Created `cron/scheduler.ts` - renamed from `cron.ts`
- Created `cron/index.ts` - unified exports
- `container.ts` reduced from 511 lines to 259 lines
- Deleted old `cron.ts`

**P1 Completed**: Separated CLI from business logic
- Created `core/chatService.ts` - extracted `processChat` function
- Created `core/index.ts` - unified exports
- `chat/index.ts` reduced from 243 lines to 110 lines
- CLI layer now only handles: readline, commands, display formatting
- Business logic is platform-agnostic, reusable by Feishu

**P2 Completed**: Cron scheduler already separated (done in P0)
- `cron/scheduler.ts` - CronService class (491 lines)
- `cron/executor.ts` - executeCronActions function (251 lines)
- `cron/index.ts` - unified exports

**P3 Completed**: Extracted Feishu command handling from gateway.ts
- Created `feishu/commands.ts` - 260 lines of command handling logic
- `feishu/gateway.ts` reduced from 588 lines to 396 lines (-192 lines)
- Commands: help, clear, history, list, new, status
- Session management extracted to commands.ts

### Final Code Metrics
| File | Before | After | Change |
|------|--------|-------|--------|
| container.ts | 511 | 279 | -232 |
| chat/index.ts | 243 | 205 | -38 |
| feishu/gateway.ts | 588 | 396 | -192 |
| **Total** | **1342** | **880** | **-462** |

### New Files Created
- `core/chatService.ts` (129 lines)
- `core/index.ts` (6 lines)
- `cron/executor.ts` (251 lines)
- `cron/scheduler.ts` (491 lines)
- `cron/index.ts` (12 lines)
- `feishu/commands.ts` (260 lines)

### Architecture After Refactoring
```
host/src/
├── core/
│   ├── index.ts              # Business logic exports
│   └── chatService.ts        # Unified chat processing
├── cron/
│   ├── index.ts              # Unified exports
│   ├── scheduler.ts          # CronService (scheduling)
│   └── executor.ts           # Cron action execution
├── feishu/
│   ├── commands.ts           # Bot command handlers
│   ├── gateway.ts            # WebSocket/message routing
│   └── ...
├── chat/
│   ├── index.ts              # CLI interaction only
│   └── feishu.ts             # Feishu bridge (uses core/chatService)
└── container.ts              # Container lifecycle only
```

---

## Phase 1: Eliminate `channels/` Directory

**Status**: Completed

### Changes
| File | Action | Description |
|------|--------|-------------|
| `cron/sender.ts` | **新增** | 从 `channels/index.ts` 移入 `ChannelRegistry`，成为 cron 专属模块 |
| `feishu/cronHandler.ts` | **新增** | 融合原 `channels/feishuHandler.ts`，消除间接层 |
| `cron/scheduler.ts` | 修改 | 更新导入路径：`../channels/index.js` → `./sender.js` |
| `index.ts` | 修改 | 更新导入：`FeishuChannelHandler` → `FeishuCronHandler` |
| `cli/index.ts` | 修改 | 更新导入路径：`../channels/index.js` → `../cron/sender.js` |
| `feishu/index.ts` | 修改 | 新增导出 `FeishuCronHandler` |
| `channels/` | **删除** | 整个目录已移除 |

### Key Decision
**Eliminated `channels/` abstraction entirely** - 发现它只是一个薄包装层，增加间接性却无实际价值。Cron 的发送逻辑直接移入 `cron/sender.ts`，实现"在哪用就放哪"的局部性原则。

---

## Phase 2: Directory Renaming

**Status**: Completed

| Before | After | Rationale |
|--------|-------|-----------|
| `chat/` | `cli/` | 更好表达"终端渠道"的意图 |
| `chat/feishu.ts` | `feishu/bot.ts` | Bot 启动器与 CLI 无关，应归属 Feishu 模块 |
| `ui.ts` | `cli/ui.ts` | 终端专用 UI 组件应放在 CLI 目录 |

---

## Code Deduplication: Unified `getOrCreateSession`

**Problem**: `bot.ts` 和 `commands.ts` 各有一个 `getOrCreateSession` 函数，后者带缓存优化，前者是简单实现。

**Solution**: 删除 `bot.ts` 中的简单版本，统一使用 `commands.ts` 中导出的缓存版本。

**Impact**:
- `bot.ts`: 161 行 → 127 行 (-34 行)
- 所有 Feishu 消息处理现在共享三层缓存（内存→DB映射→新建）
- 消除重复代码，统一维护点

---

### Today's Code Metrics Summary

| Phase | Files Changed | Lines Removed | Key Principle |
|-------|---------------|---------------|---------------|
| Phase 1 | 6 | ~40 | 消除无价值抽象层 |
| Phase 2 | 4 | ~0 | 命名即意图 |
| Deduplication | 1 | 34 | 一个概念一个实现 |
| **Total** | **11** | **~74** | |

---

### Architecture Principles Validated Today

1. **Locality of Reference** - 代码应该在它被使用的地方定义（cron 的发送器放在 cron/）
2. **Naming is Documentation** - `cli/` 比 `chat/` 更精确表达意图
3. **One Concept, One Implementation** - 发现重复就合并，不要容忍"一个简单版一个优化版"
4. **Delete, Don't Deprecate** - 直接删除旧代码，不留兼容层

---

### Notes for Tomorrow
- [x] Implement P0: Extract cron executor from container.ts
- [x] Implement P1: Create core/chatService.ts
- [x] Implement P2: Split cron scheduler vs executor responsibilities
- [x] Implement P3: Clarify Feishu abstractions (commands extracted)
- [x] Phase 1: Eliminate channels/ directory
- [x] Phase 2: Rename chat/ to cli/
- [x] Unify getOrCreateSession implementations
- [ ] Verify no circular dependencies after extraction
- [ ] Delete orphaned summarization.ts if confirmed unused
