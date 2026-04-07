---
name: "memory"
description: >
  Save and recall long-term memory. Trigger when:
  (1) User says "remember/save/record/note this";
  (2) User states preferences ("I prefer...", "always use...", "next time...");
  (3) User asks about prior context ("what did we decide?", "last time...", "do you remember...");
  (4) User makes an important decision with rationale ("use X instead of Y because...").
---

# Memory Skill

Persistent memory system for Agent. Save key information, recall historical context, and maintain continuity across sessions.

## File Structure

| Type | Path | Purpose | Token Limit |
|------|------|---------|-------------|
| **User Memory** | `memory/USER.md` | Preferences, decisions, project context | ≤ 500 tokens |
| **Session Log** | `memory/sessions/YYYY-MM-DD.md` | Daily progress, temporary todos, session notes | ≤ 800 tokens |

> **Context Injection**: System auto-loads `USER.md` + today's session log at session start. Historical sessions are retrieved on-demand via search only.

---

## When to Save (Decision Flow)

```
User message received
│
├─ Explicit command? ("记住", "保存", "记录", "注意")
│  └─ YES → Save immediately (MUST SAVE)
│
├─ Preference signal? ("我喜欢", "总是使用", "下次使用", "从现在开始使用")
│  └─ YES → Save to USER.md
│
├─ Decision signal? ("决定使用", "使用X而不是Y", "选择", "切换到")
│  └─ YES → Save decision + rationale to session log
│
├─ Todo signal? ("明天", "不要忘记", "需要", "稍后")
│  └─ YES → Save as task to session log
│
├─ Completion signal? ("完成", "修复", "解决", "正在工作")
│  └─ YES → Mark related task complete in session log
│
└─ None of the above → DO NOT SAVE
```

### Must NOT Save

- **Passwords, API keys, tokens, secrets** — never store credentials
- **One-off queries** — weather, exchange rates, quick lookups
- **Common knowledge** — easily found in docs or search engines
- **Unconfirmed speculation** — only save facts the user has stated or confirmed
- **Verbose raw data** — save summaries, not full outputs

---

## How to Save

### Step 1: Read Current File

Read the target file. If the file does not exist, create it using the corresponding template below.

### Step 2: Update Content

- **Preferences** → update or append in `USER.md`
- **Decisions / Progress / Todos** → append in today's session log
- **Conflicting info** → overwrite old value, add update date

### Step 3: Write Back

Write the updated content back to the file. Ensure token limits are respected.

### Error Handling

- If Read fails with "file not found" → create file with template, then write
- If Write fails → retry once; if still fails, inform user that memory was not saved
- Never silently drop a save operation

---

## Conflict Resolution

| Info Type | Strategy |
|-----------|----------|
| **Preferences** | New value overwrites old value. Append `(updated YYYY-MM-DD)` |
| **Decisions** | Keep old decision marked `~~[superseded]~~`, add new decision below |
| **Todos** | Mark completed with `[x]`. Remove items older than 7 days |
| **Facts** | Replace with latest confirmed information |

---

## Templates

### USER.md Template

```markdown
**Preferences**
(empty — add preferences as discovered)

**Tech Stack & Config**
(empty — add project context, tools, architecture)

**Key Decisions**
(empty — add important decisions with rationale)
```

### Session Log Template

```markdown
# YYYY-MM-DD

**Progress**
(empty)

**Decisions**
(empty)

**Todos**
- [ ] (empty)

**Notes**
(empty)
```

---

## Search Historical Memory

When user asks about past context and the answer is not in today's session or USER.md:

1. Search across all session logs using keyword matching
2. Return the most relevant entries
3. If no match found, tell user: "I don't have a record of that. Could you remind me?"

---

## Maintenance & Cleanup

### Token Budget Enforcement

Before each write, check token count:
- `USER.md` exceeds ~500 tokens → compress: merge related items, remove outdated entries
- Session log exceeds ~800 tokens → summarize older sections, keep only actionable items

### Weekly Archival (on Monday)

1. Review session logs older than 7 days
2. Extract any still-relevant info → merge into `USER.md`
3. Archive or delete stale session logs

---

## Writing Style Rules

All memory files follow these conventions:

- **English only** (except proper nouns that lose meaning in translation)
- **Dense telegraphic style**: no filler words ("You are", "You should", "The user")
- **`**Bold**` section titles** instead of `##` headers (inside files)
- **Comma/semicolon-joined facts** for related items
- **One fact per line** for unrelated items

**Good**: `Prefers 4-space indent; strict TypeScript; no semicolons in JS`
**Bad**: `The user has mentioned that they prefer to use 4 spaces for indentation. They also like TypeScript.`

---

## Format Conventions

| Type | Format | Example |
|------|--------|---------|
| Preference | `- Description` | `- 4-space indent; dark theme` |
| Decision | `- **Title**: reason` | `- **SQLite over Redis**: simpler deploy, sufficient scale` |
| Todo | `- [ ] task` | `- [ ] Fix Docker networking` |
| Completed | `- [x] task` | `- [x] Migrated auth to JWT` |
| Superseded | `- ~~old decision~~` | `- ~~Use Redis for caching~~` |

---

## Best Practices

| Do | Don't |
|----|-------|
| Save specific, actionable info | Save vague or obvious info |
| Respect token limits ruthlessly | Let files grow unbounded |
| Overwrite stale preferences | Keep contradictory entries |
| Search before saying "I don't know" | Guess from incomplete memory |
| Confirm before saving uncertain info | Save assumptions as facts |
| Skip credentials and secrets | Store any sensitive data |
