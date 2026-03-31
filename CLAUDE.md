# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MomoClaw** is a minimal AI assistant with container isolation. It runs Claude AI in isolated Docker containers for safety. The codebase is intentionally small to be easy to understand and modify.

## Architecture

### Two-Component Structure

```
Host (CLI / Bot Interfaces)
    ↓ spawns Docker container
Container (AI Agent)
    ↓ uses
Claude Agent SDK + Anthropic API
```

### Key Directories

- `host/` - Host application (TypeScript, Node.js)
  - `src/cli/` - Interactive CLI interface
  - `src/core/` - Core chat service and session management
  - `src/feishu/` - Feishu (Lark) bot integration
  - `src/weixin/` - Weixin (WeChat) bot integration
  - `src/cron/` - Scheduled task system
  - `src/db/` - SQLite database layer
  - `src/mcp/` - MCP server implementation
- `container/` - AI agent that runs inside Docker (TypeScript, Node.js)
  - `src/mcp/` - Article fetcher MCP service
- `workspace/` - Mounted to containers as `/workspace/files` (read-write)

## Commands

### Root Package Scripts

```bash
npm run setup          # Install dependencies for both host and container
npm run build          # Compile TypeScript for both host and container
npm run build:container # Build Docker image
npm run start          # Run the host CLI
npm run chat           # Start chat mode
```

### Host Package Scripts

```bash
cd host
npm run build          # Build host
npm run dev            # Run with tsx (no build needed)
npm run test           # Run tests with vitest
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Run tests with coverage
```

### Host CLI Commands

From the `host/` directory:

```bash
# Build first
cd host && npm run build

# Session management
node dist/index.js new <sessionId>      # Create new session
node dist/index.js list|ls               # List all sessions
node dist/index.js switch <sessionId>    # Switch to session
node dist/index.js delete <sessionId>    # Delete session

# Chat
node dist/index.js chat [sessionId]      # Start interactive chat
node dist/index.js                        # Default: interactive chat

# Build container image
node dist/index.js build

# Bot modes
node dist/index.js feishu                 # Start Feishu (Lark) bot
node dist/index.js weixin                 # Start Weixin (WeChat) bot
```

### Interactive Chat Commands

Within chat mode:
- `/model <name>` - Switch model (e.g., `anthropic/claude-3-5-sonnet-20241022`)
- `/system <prompt>` - Update system prompt
- `/memory` - View today's memory and available dates
- `/memory <date>` - View memory for specific date
- `/clear` - Clear session history
- `/exit` - Quit

## Key Features

### AIEOS Protocol (AI Personas)

MiniClaw uses an AIEOS-inspired system prompt loading:
- `workspace/memory/SOUL.md` - AI identity and personality
- `workspace/memory/USER.md` - User preferences and context
- These are automatically loaded and merged into the system prompt

### Daily Memory System

- Organized by date in `workspace/memory/YYYY-MM-DD/MEMORY.md`
- AI can read/write memory files to remember important information
- Recent memory (today + yesterday if available) is automatically provided in context
- `/memory` command to view and manage memory

### Real-time Thinking & Tool Events

The UI displays events in the order they happen:
- 💭 Thinking - AI's internal thought process
- 🔧 Tool Use - What tool the AI is using
- ✅ Tool Result - Result of the tool execution

### Self-Access to Code

The project code is mounted read-only at `/workspace/project` inside containers:
- AI can read its own implementation
- Code modifications require manual copying from the host

### Weixin (WeChat) Bot Integration

The project includes a Weixin bot implementation with these key features:
- **QR Code Login**: Terminal-based QR code scanning for bot authentication
- **Long Polling**: Real-time message receiving via getUpdates endpoint (35s timeout)
- **Context Token Management**: Each user's latest context_token is stored and used for replies
- **Media Decryption**: AES-128-ECB decryption for CDN-hosted images
- **Typing Indicator**: Sends "typing" status while waiting for LLM responses
- **User Isolation**: Each Weixin user gets their own session mapped as `wx_<userId>`

Architecture layers:
- `weixin/client.ts` - API auth, QR login, request headers
- `weixin/gateway.ts` - Long polling connection and message pulling
- `weixin/crypto.ts` - AES-128-ECB decryption for media files
- `weixin/bot.ts` - Business logic layer, converts Weixin messages to standard format

### MCP (Model Context Protocol) Services

- **Host MCP Server**: Runs on port 51506
- **Article Fetcher**: Container-side MCP service for fetching articles from platforms like Zhihu, WeChat, Juejin, CSDN, etc.

## Development Workflow

### Setup

```bash
npm run setup
cd host
cp .env.example .env
# Edit .env with ANTHROPIC_API_KEY
```

### Build

```bash
npm run build
npm run build:container  # Or: cd host && node dist/index.js build
```

### Run

```bash
npm run chat
```

### TypeScript Configuration

Both host and container use:
- Target: ES2022
- Module: NodeNext (ES Modules)
- Strict: true
- Output: `./dist`

## Core Architecture Details

### Data Flow

1. User input → Host CLI (`host/src/index.ts`)
2. Message saved to SQLite (`host/src/db.ts`)
3. Host spawns Docker container (`host/src/container.ts`)
4. Container reads payload, uses Claude Agent SDK (`container/src/index.ts`)
5. Result streamed back, saved to DB

### Session Management

Sessions are stored in SQLite (`host/data/miniclaw.db`):
- Each session has independent history and configuration
- Session state is maintained through SQLite message history
- Only one session is active at a time

### Container Isolation

- `/workspace/files` - User workspace (rw, from host/workspace)
- `/workspace/project` - Project source code (ro, from project root)
- Temp input/output directories created per-run
- Resource limits: 2GB memory, 2 CPUs
- Auto-removed after exit

### Container Shell Configuration

The container includes bash and sets `SHELL=/bin/bash` for Claude Agent SDK

### Configuration

Environment variables (`host/.env`):
```bash
# API Keys (at least one required)
ANTHROPIC_API_KEY=          # Required for Anthropic models
ANTHROPIC_BASE_URL=         # Optional (for Kimi, etc.)
OPENAI_API_KEY=             # Optional for OpenAI-compatible models
OPENAI_BASE_URL=            # Optional

# Default Settings
MODEL=anthropic/claude-3-5-sonnet-20241022
MAX_TOKENS=4096
WORKSPACE_DIR=./workspace
CONTAINER_TIMEOUT=300000
DB_PATH=./data/miniclaw.db
DEFAULT_SYSTEM_PROMPT=

# Optional: Additional API keys
GITHUB_TOKEN=
CONTEXT7_API_KEY=

# Feishu (Lark) Bot Configuration (optional)
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_DOMAIN=feishu
FEISHU_ENCRYPT_KEY=
FEISHU_VERIFICATION_TOKEN=
FEISHU_AUTO_REPLY_GROUPS=

# Weixin (WeChat) Bot Configuration (optional)
WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com
WEIXIN_CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
```

## Key Files

| File | Purpose |
|------|---------|
| `host/src/index.ts` | Main entry point, CLI and bot command routing |
| `host/src/config.ts` | Environment configuration loading |
| `host/src/container.ts` | Docker container orchestration |
| `host/src/core/chatService.ts` | Core chat orchestration |
| `host/src/db/` | SQLite session/message/task storage |
| `host/src/cron/` | Scheduled task system |
| `host/src/feishu/` | Feishu (Lark) bot integration |
| `host/src/weixin/client.ts` | Weixin API client and auth |
| `host/src/weixin/gateway.ts` | Weixin long polling message gateway |
| `host/src/weixin/crypto.ts` | Weixin media decryption (AES-128-ECB) |
| `host/src/weixin/bot.ts` | Weixin bot business logic |
| `host/src/cli/ui.ts` | CLI UI components and event display |
| `container/src/index.ts` | Claude Agent SDK integration |
| `container/src/mcp/article-fetcher.ts` | Article fetching MCP service |
| `host/src/types.ts`, `container/src/types.ts` | Type definitions |

## Model Format

Models are specified as `provider/model-name`:
- `anthropic/claude-3-5-sonnet-20241022
- `anthropic/claude-3-opus-20240229
- `openai/kimi-latest
- `openai/gpt-4

Note: Currently only Anthropic provider is fully supported by the Claude Agent SDK.

## Reference Documentation

- `README.md` - Quick start guide (Chinese)
- `openclaw-architecture-report.md` - Comprehensive architecture reference (Chinese)
- `从0到1教你实现一个自己的OpenClaw.md` - Step-by-step tutorial (Chinese)
- `nanoclaw/README.md` - Full NanoClaw documentation (English)
