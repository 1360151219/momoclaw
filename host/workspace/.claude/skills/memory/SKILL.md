---
name: "memory"
description: "Intelligent memory management skill. Manages three types of memory: 1) Daily memory (/workspace/files/memory/YYYY-MM-DD/MEMORY.md) records session details; 2) USER.md updates user preferences and context; 3) SOUL.md updates AI identity settings. Triggers: 'remember this', 'save to memory', 'update memory', 'update USER.md', 'update SOUL.md'. **Auto-detect and save**: user preferences, important decisions, todo items, key solutions, project configs. **Actively save important info, don't wait for user command.**"
---

# Memory Skill

Enable long-term memory for Agent; auto-save important info and recall historical context when needed.

## Memory File Structure

### Three Memory Types

| Type | File Path | Content | Update Frequency |
|------|-----------|---------|------------------|
| **Daily Memory** | `/workspace/files/memory/YYYY-MM-DD/MEMORY.md` | Session details, progress, temporary todos | Multiple times daily |
| **User Memory** | `/workspace/files/memory/USER.md` | User preferences, long-term context, key history | When preferences/context changes |
| **AI Identity** | `/workspace/files/memory/SOUL.md` | AI identity, principles, capabilities | When identity settings change |

**Today's Memory**: `/workspace/files/memory/YYYY-MM-DD/MEMORY.md`

### Standard Templates

**Daily Memory Example:**
```markdown
# Daily Memory

**Important Facts**
Key preferences discovered; project status updates; critical config values.

**Decisions Made**
- **Use SQLite instead of Redis**: Simpler deployment; sufficient for current scale.
- **4-space indentation**: User preference over 2-space.

**Progress**
- [x] Migrated auth to JWT; token refresh working.

**Notes for Tomorrow**
- [ ] Fix Docker networking issue; test production build.
```

**SOUL.md Example (English, dense style):**
```markdown
**Identity**: ENTP AI partner; pragmatic; anti-hustle ally.

**Core Principles**
User autonomy above all; freedom to game/rest is sacred; no anxiety-inducing language; humor essential.

**Capabilities**: Full-stack coding; research; task execution; skill evolution.

**Communication Style**
Telegraphic when appropriate; Chinese primary but English for technical terms; no emojis unless requested.
```

**USER.md Example (English, dense style):**
```markdown
**Role**: Developer; MomoClaw maintainer.

**Preferences**
TypeScript strict mode; 4-space indent; single quotes; aggressive deletion over accumulation; modularity > monoliths.

**Project Context**
Building MomoClaw: minimal educational AI assistant; container isolation; local-first; AIEOS protocol support.

**Stack**: TypeScript, Node.js, Docker, SQLite, Claude Agent SDK.
```

## When to Save Memory (Decision Flow)

```
Did user explicitly say "remember"/"save"/"record"?
├─ Yes → Save immediately
└─ No → Check for these signals:

  - "I like..."/"Next time..."/"Always..." → Save preference
  - "Decide to..."/"Choose..."/"Use...instead of..." → Save decision
  - "Tomorrow do..."/"Don't forget..." → Save todo
  - "Done"/"Solved"/"The reason is..." → Save result/solution
  - Specific paths/configs/parameters involved → Save key values
```

### Priority Levels

**🔴 Must Save**:
- Explicit user command ("remember this")
- Important decisions and rationale
- User preferences/habits
- Todo items/goals

**🟡 Recommended Save**:
- Key problems and solutions
- Important configs/paths
- Project milestones

**🟢 Skip**:
- Temporary queries/answers
- Common knowledge
- Content easily found in technical docs

## How to Save Memory

### Daily Memory (Read → Modify → Write)

```typescript
// 1. Read today's memory
const today = new Date().toISOString().split('T')[0];
const current = await Read({
  file_path: `/workspace/files/memory/${today}/MEMORY.md`
});

// 2. Append content to appropriate section
// Preferences → Important Facts
// Decisions → Decisions Made
// Tasks → Notes for Tomorrow
// Completed → Progress

// 3. Write back to file
await Write({
  file_path: `/workspace/files/memory/${today}/MEMORY.md`,
  content: updated
});
```

### USER.md Update Guide

**When to Update**:
- User explicitly states preference ("I prefer 4-space indent")
- User workflow changes ("Use this approach from now on")
- Project context changes (tech stack, architecture decisions)

**Update Principles**:
- **English only** (except user-language-specific terms)
- **< 1000 tokens**, ruthlessly remove outdated content
- **Telegraphic style**: dense sentences, no filler words, `**Bold**` titles instead of `##`
- **Comma/semicolon-joined facts**, not bullet lists

```typescript
// Read current USER.md
const userMd = await Read({
  file_path: '/workspace/files/memory/USER.md'
});

// Use Edit for precise replacement, maintain dense format
await Edit({
  file_path: '/workspace/files/memory/USER.md',
  old_string: '- Prefers 2-space indentation',
  new_string: '- Prefers 4-space indentation; strict TypeScript'
});
```

### SOUL.md Update Guide

**When to Update**:
- AI identity needs adjustment (personality, communication style)
- Capability boundaries expand (new skill areas)
- Core principles change

**Update Principles**:
- **English only** (except user-language-specific terms)
- **< 1000 tokens**, merge duplicate content
- **Telegraphic style**: dense sentences, no filler words
- **Maintain identity consistency**, incremental updates

```typescript
const soulMd = await Read({
  file_path: '/workspace/files/memory/SOUL.md'
});

// Use Edit for precise modification, maintain dense format
await Edit({
  file_path: '/workspace/files/memory/SOUL.md',
  old_string: '**Communication Style**:\n- Primary Chinese',
  new_string: '**Communication Style**:\n- Bilingual; technical terms in English'
});
```

### Writing Style for `memory/` Files

Dense, telegraphic short sentences. No filler words ("You are", "You should", "Your goal is to"). Comma/semicolon-joined facts, not bullet lists. `**Bold**` paragraph titles instead of `##` headers. Prioritize information density and low token count.

## Language & Token Constraints

**All UPPERCASE `.md` files under `memory/` (e.g., `SOUL.md`, `USER.md`) must be written in English**, except for user-language-specific proper nouns, names, or terms that lose meaning in translation.

`SOUL.md` and `USER.md` are loaded into context every session. **Keep each file under 1000 tokens.** Be ruthless about deduplication and conciseness. Move detailed or archival information to separate files under `memory/` if needed.

## Format Conventions

**Preferences**: `- Description (e.g., Prefers 4-space indent)`
**Decisions**: `- **Title**: Decision content + reason`
**Tasks**: `- [ ] Task description`
**Completed**: `- [x] Completed content`

## Search Historical Memory

```typescript
// Search all memory files
await Grep({
  pattern: "keyword",
  path: "/workspace/files/memory",
  output_mode: "content"
});

// List all memory dates
await Glob({
  pattern: "/workspace/files/memory/*/MEMORY.md"
});
```

## Automatic Memory Injection

System auto-reads today's and yesterday's memories at session start, injecting into `## Memory Context` section.

**Agent Should**:
- Naturally integrate into conversation without mentioning "according to memory..."
- Combine memory content when responding to user

## Best Practices

✅ **Concise & Specific**: "Prefers 4-space indent"
✅ **Actionable**: "Complete Docker optimization tomorrow"
✅ **Contextual**: "Project uses MomoClaw architecture"

❌ Avoid: vague, temporary, duplicate, overly long content

## Proactive Trigger Scenarios

| Scenario | Signal | Save Content |
|----------|--------|--------------|
| Decision | "Decide..."/"Use...instead of..." | Decision + reason |
| Correction | "No"/"Should be" | Correct info |
| Completion | "Done"/"Tests passed" | Results |
| Preference | "I like..."/"Next time..." | Specific preference |

## Tool Quick Reference

| Operation | Tool | Parameters |
|-----------|------|------------|
| Read | `Read` | `/workspace/files/memory/YYYY-MM-DD/MEMORY.md` |
| Search | `Grep` | `pattern`, `path: /workspace/files/memory` |
| List | `Glob` | `pattern: /workspace/files/memory/*/MEMORY.md` |
