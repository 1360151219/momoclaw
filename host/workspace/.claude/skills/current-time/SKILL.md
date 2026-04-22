---
name: current-time
description: >
  Get the current date (with day of week) and time (HH:MM:SS) in a specified timezone.
  Auto-trigger when needing to know current time, date, or day of week — including when
  guessing user's location based on schedule, answering "what time is it", "what day is it",
  "today is what date", or any context where accurate real-time clock data is needed.
  Do not trigger proactively at the start of conversations. Only use this skill when the
  user's request or the task truly depends on accurate real-time clock data.
---

# Current Time

Get the current date and time with day of week using the system clock.

## Workflow

### 1. Determine timezone

- Default: `Asia/Shanghai` (UTC+8, user's primary timezone).
- If the user specifies a different timezone, use that instead.

### 2. Get current time

Run the following Bash command:

```bash
TZ="{timezone}" date "+%Y-%m-%d %A %H:%M:%S %Z"
```

Example output: `2026-03-09 Monday 23:38:42 CST`

### 3. Use the result

- Parse the output: date, day of week, time, timezone.
- Use this information to answer the user's question or inform your own reasoning.
- Do NOT present the raw command output — incorporate it naturally into your response.
