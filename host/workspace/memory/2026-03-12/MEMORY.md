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

### Notes for Tomorrow
- [x] Implement P0: Extract cron executor from container.ts
- [x] Implement P1: Create core/chatService.ts
- [x] Implement P2: Split cron scheduler vs executor responsibilities
- [x] Implement P3: Clarify Feishu abstractions (commands extracted)
- [ ] Verify no circular dependencies after extraction
- [ ] Delete orphaned summarization.ts if confirmed unused
