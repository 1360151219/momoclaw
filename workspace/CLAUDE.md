# MiniClaw Project

You are working on MiniClaw, a minimal AI assistant framework with container isolation.

## Key Files

- `host/src/index.ts` - CLI interface
- `host/src/db.ts` - SQLite database operations
- `host/src/container.ts` - Docker container management
- `container/src/index.ts` - Claude Agent SDK integration (NEW!)

## Guidelines

1. Work in `/workspace/files` directory
2. Use TypeScript for all code
3. Keep things simple and minimal
4. Test your changes before committing

## Useful Commands

```bash
cd host && npm run build
cd container && npm run build
miniclaw build
miniclaw chat
```
