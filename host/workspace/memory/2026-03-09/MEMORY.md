# Daily Memory

## Important Facts

**Codebase Readability Review** (2026-03-09): MomoClaw project has several readability issues identified.

## Decisions Made

**Refactor Plan for db.ts**: Split into functional modules under `db/` folder.
- `connection.ts`: DB instance management (initDatabase, getDb)
- `sessions.ts`: Session CRUD operations
- `messages.ts`: Message CRUD operations
- `tasks.ts`: ScheduledTask + TaskRunLog operations

## Progress

- [x] db.ts refactor completed (2026-03-09)
  - Created `host/src/db/` folder with 5 modules
  - connection.ts: DB instance management
  - sessions.ts: Session CRUD
  - messages.ts: Message CRUD
  - tasks.ts: ScheduledTask + TaskRunLog
  - index.ts: unified exports
  - Updated all imports in index.ts, container.ts, cron.ts, test/cron.test.ts
  - Build verified: tsc compiles successfully

- [x] index.ts refactor completed (2026-03-09)
  - Deleted all CLI Commands (new, list, switch, delete, memory, task:*, etc.)
  - 704 lines → 70 lines (90% reduction)
  - Extracted core chat logic to `host/src/chat/index.ts`
  - `processChat()`: platform-agnostic core function for Feishu integration
  - `startInteractiveChat()`: terminal UI wrapper
  - Kept only `build` subcommand and default chat mode
  - Build verified: tsc compiles successfully

## Notes for Tomorrow

**Pending Refactors** (from code review):
1. P1: `container.ts` (503 lines) - giant switch-case for cron handlers, use strategy pattern
2. P1: `cron.ts` (465 lines) - separate parser from scheduler
3. P3: `types.ts` (116 lines) - okay for now, could use namespaces

**Key Insight**: host/src/index.ts is the biggest problem - mixes CLI setup, interactive chat loop, command handling all in one file. Needs:
```
host/src/
├── index.ts           # CLI init only
├── chat/
│   ├── index.ts       # chat loop
│   ├── commands.ts    # /exit, /model handlers
│   └── handlers.ts    # AI response logic
└── commands/          # CLI subcommands
    ├── session.ts
    ├── task.ts
    ├── memory.ts
    └── build.ts
```

**Feishu Integration Prep**: `chat/index.ts` exports `processChat()` - pure function, no terminal dependencies. Ready for Feishu webhook handler.
