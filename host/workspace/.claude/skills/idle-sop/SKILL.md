---
name: "idle-sop"
description: >
  Session idle shutdown SOP — automatically triggered by the system when a session is about to be
  reclaimed due to inactivity timeout. This skill MUST be invoked when the system sends a
  "[System] idle-sop" directive. It orchestrates a three-phase shutdown sequence:
  Phase 1 — Summarize the session context.
  Phase 2 — Persist valuable information via the memory skill.
  Phase 3 — Evaluate whether any follow-up work should be scheduled as autonomous tasks.
  Do NOT use this skill unless the system idle-sop directive is received.
---

# Idle SOP — Session Shutdown Sequence

Three-phase autonomous shutdown procedure executed when a session is about to be reclaimed.
The goal is to ensure nothing valuable is lost, and to enable the Agent to proactively continue
unfinished work even after the session ends.

---

## Phase 1: Summarize

Before taking any action, first build a clear picture of what happened in this session.

### Steps

1. **Scan conversation context** — review the full conversation history available in the current session.
2. **Produce a structured summary** with the following sections (keep the entire summary under 300 tokens):

```
**Session Summary**

**What was done**: (1-3 sentences — tasks completed, problems solved, artifacts produced)

**What was learned**: (new knowledge, error resolutions, environment facts, tool discoveries)

**What is unfinished**: (pending tasks, blocked items, open questions the user left behind)

**User signals**: (any stated preferences, decisions, or corrections worth remembering)
```

3. **If the session was trivial** (e.g., a single greeting, a quick lookup with no follow-up), produce a one-line summary instead: `**Session Summary**: Trivial session — no significant content.` Then skip directly to the end — do NOT proceed to Phase 2 or Phase 3.

> The summary is an internal working document for the next two phases. Do NOT present it to the user.

---

## Phase 2: Memory Persistence

Use the summary from Phase 1 to decide whether the `memory` skill should be invoked.

### Decision Flow

```
Review the summary
│
├─ "What was learned" has content?
│  └─ YES → Save to memory (session log and/or USER.md)
│
├─ "User signals" has content?
│  └─ YES → Save preferences/decisions to USER.md
│
├─ "What is unfinished" has actionable todos?
│  └─ YES → Save todos to today's session log
│
└─ All sections empty or trivial?
   └─ Skip memory — nothing worth persisting
```

### Execution

If any of the above branches say YES:

1. Invoke the `memory` skill.
2. Pass along the relevant parts of the summary as context.
3. Let the memory skill handle file reads, updates, and writes per its own protocol.

### What NOT to save

- Passwords, API keys, tokens, secrets — never
- One-off lookups with no lasting value
- Information already present in existing memory files
- Raw verbose outputs — summarize first

---

## Phase 3: Autonomous Task Scheduling

Review the summary's **"What is unfinished"** section and determine if any item can be completed
autonomously by the Agent without user interaction.

### Decision Flow

```
For each unfinished item:
│
├─ Is it a reminder / time-based notification?
│  (e.g., "remind me tomorrow at 9am", "check back on Friday")
│  └─ YES → Schedule a once task with the appropriate timestamp
│
├─ Can the Agent complete it independently?
│  (e.g., "research X and summarize", "fetch latest docs for Y",
│   "write a draft of Z", "organize these files")
│  └─ YES → Schedule a once task with a clear action prompt
│     Prompt should include:
│     - What to do (specific, actionable instruction)
│     - Where to save results (e.g., memory, a file path)
│     - How to notify the user of the result
│
├─ Is it a recurring task the user implied?
│  (e.g., "check this every morning", "keep an eye on X")
│  └─ YES → Schedule a cron task with appropriate expression
│
└─ Requires user input / decision / is ambiguous?
   └─ Do NOT schedule — save as a todo in memory instead
```

### How to Schedule

Use the `schedule_task` MCP tool (available as `mcp__momoclaw_mcp__schedule_task`):

| Parameter | Description |
|-----------|-------------|
| `prompt` | A clear, self-contained instruction for the future Agent execution. Include all necessary context — the future Agent will not have this session's history. |
| `scheduleType` | `"once"` for one-time tasks, `"cron"` for recurring tasks |
| `scheduleValue` | For `once`: 13-digit millisecond timestamp. For `cron`: standard cron expression (min hour day month weekday) |

### Prompt Writing Guidelines

The prompt for a scheduled task must be **self-contained**. The future Agent instance that executes
it will have no memory of this session. Include:

- **Context**: Why this task exists (1 sentence)
- **Action**: Exactly what to do (specific steps)
- **Output**: Where to save or how to deliver the result
- **Constraints**: Any boundaries (e.g., "do not contact external APIs", "keep under 500 words")

**Example prompts**:

```
The user asked to be reminded about a meeting with the design team.
Action: Send a friendly reminder message: "Hey! Don't forget your meeting with the design team today."
```

```
The user was researching React Server Components but ran out of time.
Action: Search for the latest React Server Components documentation and best practices (2024+).
Summarize the key patterns in under 500 words.
Save the summary to memory/sessions/{today's date}.md under a "Research: RSC" section.
```

```
The user wants a daily morning briefing.
Action: Fetch today's top tech news headlines.
Compose a brief morning summary (3-5 items, one sentence each).
Deliver as a message to the user.
```

### Safety Rules

- **Never schedule tasks that involve sensitive operations** (deleting files, modifying credentials, making purchases, sending emails to external parties)
- **Never schedule tasks with vague or open-ended prompts** — if you can't write a specific action, save it as a memory todo instead
- **Limit to 3 scheduled tasks maximum** per idle-sop invocation — prioritize by importance
- **Default to `once` type** unless the user explicitly expressed recurrence

---

## Completion

After all three phases are complete, respond with exactly:

```
idle-sop completed.
```

If the session was trivial (detected in Phase 1), respond with:

```
idle-sop skipped — trivial session.
```

Do NOT add any extra commentary, greetings, or explanations. This is a system-level operation.
