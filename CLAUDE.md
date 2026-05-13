# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MomoClaw** is a minimal AI assistant with container isolation. It runs Claude AI in isolated Docker containers for safety, using the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The codebase is intentionally small to be easy to understand and modify.

## Architecture

### Two-Component Structure

```
Host (CLI / Feishu / Weixin)
    ↓ spawns Docker container per session
Container (Claude Agent SDK)
    ↓ uses
Anthropic API + MCP servers
```

The Host orchestrates sessions and channels. Each session gets a long-running Docker container (idle timeout: 30 min). The Container runs the Claude Agent SDK with MCP servers for article fetching, cron scheduling, GitHub, etc.

### Key Directories

- `host/` - Host application (TypeScript, Node.js, ESM)
  - `src/cli/` - Interactive CLI interface
  - `src/core/` - Chat service, session queue, command executor
  - `src/feishu/` - Feishu (Lark) bot (WebSocket via official SDK)
  - `src/weixin/` - Weixin (WeChat) bot (long polling)
  - `src/cron/` - Scheduled task scheduler, executor, and channel-based result routing
  - `src/db/` - SQLite layer (better-sqlite3, WAL mode)
  - `src/mcp/` - Host-side MCP server (Express + SSE)
- `container/` - AI agent Docker image (TypeScript, Node.js, Alpine)
  - `src/mcp/` - Article fetcher MCP service + container-side MCP routing
- `workspace/` - Mounted to containers as `/workspace/files` (read-write)

## Commands

### Root Package Scripts

```bash
npm run setup             # Install deps for both + build host + build Docker image
npm run build             # Build host + build Docker image
npm run build:host        # Build host only (tsc)
npm run build:container   # Build container only (tsc)
npm run build:docker      # Build Docker image (linux/amd64)
npm run build:docker-linux # Build + push Docker image to Aliyun registry
npm run start             # Start host CLI (default chat)
npm run start:feishu      # Start Feishu bot only
npm run start:weixin      # Start Weixin bot only
npm run start:all         # Start all configured channel bots
```

### Host Package Scripts

```bash
cd host
npm run build             # tsc
npm run dev               # Run with tsx (no build needed)
npm run test              # vitest run
npm run test:watch        # vitest (watch mode)
npm run test:coverage     # vitest run --coverage
```

### Host CLI Commands

From the `host/` directory (after building):

```bash
node dist/index.js                    # Interactive chat (uses active or "default" session)
node dist/index.js chat [sessionId]   # Start interactive chat
node dist/index.js build              # Build Docker image
node dist/index.js feishu             # Start Feishu bot
node dist/index.js weixin             # Start Weixin bot
node dist/index.js all                # Start all configured channel bots simultaneously
```

### Interactive Chat Commands

- `/model <name>` - Switch model
- `/system <prompt>` - Update system prompt
- `/memory` - View today's memory
- `/memory <date>` - View memory for specific date
- `/clear` - Clear session history
- `/new` - Create a new session
- `/history` - View session message history
- `/exit` - Quit

Same slash commands work across Feishu and Weixin channels via `host/src/core/commands/executor.ts`.

## Core Architecture Details

### Data Flow (per message)

1. User input arrives via CLI, Feishu WebSocket, or Weixin long polling
2. `processChat()` in `host/src/core/chatService.ts` enqueues via `SessionQueue` (per-session serialization)
3. User message saved to SQLite
4. `ContainerManager.getOrStartContainer()` starts/reuses a Docker container
5. `AgentRunner.run()` writes payload to input file, runs `docker exec`, streams stdout (text + tool events via `__TOOL_EVENT__:` marker protocol)
6. Container reads payload, runs Claude Agent SDK with `resume` if `claudeSessionId` exists
7. Result written to output JSON file, parsed by host, assistant message saved to DB
8. Channel context attached to payload for cron task result routing

### Container Lifecycle

- **Startup**: `ContainerManager` creates a Docker container with `tail -f /dev/null` as the long-running process
- **Per-run**: `AgentRunner` uses `docker exec` to invoke `node /app/dist/index.js` with env vars for input/output paths
- **Idle cleanup**: After 30 min of inactivity, the container runs an auto-summary SOP (via `SessionQueue`) to save memories, then the container is destroyed
- **Graceful shutdown**: All containers destroyed on SIGINT/SIGTERM/exit
- Mounts: `/workspace/files` (rw), `projects/momoclaw` (rw), `/workspace/session_tmp` (rw), `~/.claude` (rw, Claude SDK state)
- Resource limits: 2GB memory, 2 CPUs

### SessionQueue (per-session serialization)

`host/src/core/sessionQueue.ts` — Ensures messages in the same session are processed sequentially (FIFO), preventing concurrent Docker exec calls on the same container. Different sessions run concurrently.

### Claude Agent SDK Resume Mechanism

The container uses the SDK's `resume` option with `claudeSessionId` to restore conversation context across runs. The session ID is persisted in the database (`sessions.claudeSessionId`). Messages array in the payload is empty — the SDK loads history from its own persistence layer.

When the SDK compacts context (`compact_boundary` event), the container extracts the compacted summary and the host saves it via `updateSessionSummary()`.

### Container MCP Servers

Inside the container, the agent has access to:
- `momoclaw_mcp` — Article fetcher (local, `container/src/mcp/`)
- `host_mcp` — Host MCP server via SSE (cron task scheduling, listing, deletion)
- `context7` — Context7 API (HTTP)
- `bilibili` — Bilibili MCP server (local process)
- `github` — GitHub MCP server (local process)

### Host MCP Server

`host/src/mcp/server.ts` — Express server on `HOST_MCP_PORT` (default 51506). Exposes SSE endpoint that creates per-session MCP servers with tools: `schedule_task`, `list_scheduled_tasks`, `delete_task`. Each SSE connection gets a session-specific MCP server, allowing the container's agent to manage cron tasks.

### Cron System

Three schedule types: `cron` (cron-parser expressions), `interval` (seconds), `once` (millisecond timestamp).

- `CronService` (`host/src/cron/scheduler.ts`) polls every 30s for due tasks, executes them via `SessionQueue` + Docker container
- `channelRegistry` (`host/src/cron/sender.ts`) routes task results back to originating channels (Feishu, Weixin, terminal)
- `executeCronActions()` (`host/src/cron/executor.ts`) handles cron tool calls from the container (create/list/pause/resume/delete tasks)
- Each `ChannelHandler` implements `sendMessage()` and `isAvailable()` for result push

### Channel Architecture

All channels (CLI, Feishu, Weixin) use the same `processChat()` function in `chatService.ts`. Each provides:
- A `Session` (created/retrieved from SQLite)
- A `ChannelContext` with `type` and `channelId` for cron result routing
- Optional streaming/text callbacks (`onChunk`, `onToolEvent`)

Feishu uses the official Lark SDK (`@larksuiteoapi/node-sdk`) with WebSocket event dispatching and streaming card updates. Weixin uses long polling with QR code login, image decryption (AES-128-ECB), and context token management.

## Configuration

Environment variables in `host/.env` (copy from `host/.env.example`):

```bash
# Required
ANTHROPIC_API_KEY=

# Optional overrides
ANTHROPIC_BASE_URL=
OPENAI_API_KEY=
OPENAI_BASE_URL=
MODEL=anthropic/claude-3-5-sonnet-20241022
MAX_TOKENS=4096
WORKSPACE_DIR=./workspace
CONTAINER_TIMEOUT=172800000   # default 2 days in ms
DB_PATH=./data/momoclaw.db
HOST_MCP_PORT=51506
GITHUB_TOKEN=
CONTEXT7_API_KEY=

# Feishu Bot (optional)
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_DOMAIN=feishu
FEISHU_ENCRYPT_KEY=
FEISHU_VERIFICATION_TOKEN=
FEISHU_AUTO_REPLY_GROUPS=

# Weixin Bot (optional)
WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com
WEIXIN_CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
```

Note: Currently only the Anthropic provider works end-to-end — the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) does not support OpenAI models.

### Model Format

Models are specified as `provider/model-name`:
- `anthropic/claude-sonnet-4-6`
- `anthropic/claude-3-5-sonnet-20241022`
- `openai/kimi-latest` (host config only, SDK won't use it)

## Key Files

| File | Purpose |
|------|---------|
| `host/src/index.ts` | Main entry: CLI routing, bot startup, graceful shutdown |
| `host/src/config.ts` | Env loading, provider resolution (`getApiConfig`) |
| `host/src/container.ts` | `ContainerManager` (lifecycle), `AgentRunner` (exec), idle cleanup |
| `host/src/core/chatService.ts` | `processChat()` — platform-agnostic message processing |
| `host/src/core/sessionQueue.ts` | Per-session FIFO queue to serialize container access |
| `host/src/core/commands/executor.ts` | Shared slash command handler across channels |
| `host/src/cron/scheduler.ts` | `CronService` — poll, execute, calculate next run |
| `host/src/cron/executor.ts` | Processes cron tool calls from container |
| `host/src/cron/sender.ts` | `channelRegistry` — routes task results to channels |
| `host/src/mcp/server.ts` | Host MCP server (SSE), exposes cron tools to container |
| `host/src/db/connection.ts` | SQLite init (WAL, foreign keys, all table creation) |
| `host/src/cli/index.ts` | Interactive terminal chat loop |
| `host/src/feishu/gateway.ts` | WebSocket event dispatch, streaming card updates |
| `host/src/feishu/bot.ts` | Feishu message → processChat bridge, image download |
| `host/src/weixin/gateway.ts` | Long polling, image decryption, message unification |
| `host/src/weixin/bot.ts` | Weixin message → processChat bridge |
| `container/src/index.ts` | Container entry: reads payload, runs SDK, writes result |
| `container/src/mcp/server.ts` | Article fetcher MCP implementation |
| `host/src/types.ts` | All shared TypeScript types |
