# Daily Memory - 2026-03-11

## Design Patterns Established

### Modular Database Initialization
**Principle**: Each module owns its table schema; connection.ts orchestrates.

**Structure**:
```
db/
├── connection.ts     # Calls all init functions
├── sessions.ts       # Exports initSessionsTable(db)
├── messages.ts       # Exports initMessagesTable(db)
├── tasks.ts          # Exports initTasksTable(db), initTaskRunLogsTable(db)
└── feishuMappings.ts # Exports initFeishuMappingsTable(db)
```

**Benefits**:
- Single responsibility per module
- Local changes don't affect other files
- Easy to add new tables
- connection.ts stays lean (~20 lines vs ~100 lines)

### Dual-Layer Caching Architecture
**Pattern**: Memory cache + DB persistence

**Implementation** (FeishuGateway):
- `Map<string, string> sessionCache` for hot data
- `feishu_mappings` table for persistence
- `warmupCache()` loads all mappings at startup
- Cache invalidation deletes both layers

**Lookup Flow**:
1. Check memory cache (O(1))
2. Check DB mapping table (indexed query)
3. Create new session + update both layers

### Session ID Lifecycle (Feishu Integration)
**Format**: `feishu_${chatId}_${timestamp}`

**Key Insight**: Each `/new` command creates new session with fresh timestamp, old session deleted. chat-to-session mapping updated atomically in both cache and DB.

## Progress
- [x] Refactored initDatabase() to modular pattern
- [x] Added feishu_mappings table with dual-layer caching
- [x] Fixed warmupCache() timing (moved to start())
- [x] Added stale mapping cleanup in deleteMapping()
- [x] Documented session ID flow with flowchart

## Decisions
- **Modular > Monolithic**: Table DDL belongs with its CRUD operations
- **Cache warming at start()**: Not in constructor, ensures DB is ready
- **Aggressive cleanup**: When cache entry invalid, also delete DB mapping
