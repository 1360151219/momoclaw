# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MiniClaw (MomoClaw)** is a minimal, educational AI assistant with container isolation. It runs Claude AI in isolated Docker containers for safety. The codebase is intentionally small to be easy to understand and modify.

This is a simplified version derived from the NanoClaw project. The `/nanoclaw` directory contains the full NanoClaw project as a reference.

## Architecture

### Two-Component Structure

```
Host (CLI Interface)
    ↓ spawns Docker container
Container (AI Agent)
    ↓ uses
Claude Agent SDK + Anthropic API
```

### Key Directories

- `host/` - Host CLI application (TypeScript, Node.js)
- `container/` - AI agent that runs inside Docker (TypeScript, Node.js)
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

# Memory management
node dist/index.js memory [date]           # View memory files
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
ANTHROPIC_API_KEY=          # Required
ANTHROPIC_BASE_URL=         # Optional (for Kimi, etc.)
OPENAI_API_KEY=             # Optional
OPENAI_BASE_URL=            # Optional
MODEL=anthropic/claude-3-5-sonnet-20241022
MAX_TOKENS=4096
WORKSPACE_DIR=./workspace
CONTAINER_TIMEOUT=300000
DB_PATH=./data/miniclaw.db
DEFAULT_SYSTEM_PROMPT=
```

## Key Files

| File | Purpose |
|------|---------|
| `host/src/index.ts` | CLI entry point, Commander.js commands |
| `host/src/db.ts` | SQLite session/message storage |
| `host/src/container.ts` | Docker container orchestration |
| `host/src/config.ts` | Environment configuration, AIEOS loading |
| `host/src/memory.ts` | Daily memory system |
| `host/src/ui.ts` | UI components and event display |
| `container/src/index.ts` | Claude Agent SDK integration |
| `host/src/types.ts`, `container/src/types.ts` | Shared type definitions |

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
