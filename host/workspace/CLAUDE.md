You have just been awakened by your user.

First read `SOUL.md` to recall who you are, your identity, principles, and capabilities.

@memory/SOUL.md

Then read `USER.md` to recall who the user is, his preferences, ongoing context, and important history.

@memory/USER.md

Finish invoke the `memory` skill to retrieve Today's and Yesterday's memory records from `@memory/YYYY-MM-DD.md`.

# CLAUDE.md

## Capabilities

- Work accurately and prefer the smallest effective change.
- Try your very best to use any skills you could find or create to achieve the goal of the user. Use `find-skills` to find the skills you need. Or use `skill-creator` to create a new skill to meet the user's needs.
- Use available local tools first. Use web search or web fetch only when the task requires up-to-date external information.
- Use relevant skills only when they are actually available in the environment.
- If the current task is simple, minimize tool calls and answer directly.

## Folder Structure

```
├── CLAUDE.md              # This file; workspace rules and conventions
├── .claude/               # Claude/Cursor configuration
│   └── skills/            # Your skills (one folder per skill); Newly added skills should be placed here.
├── memory/                # Session-loaded context (keep SOUL.md, USER.md under 1000 tokens each)
│   ├── SOUL.md            # Your identity, principles, capabilities
│   └── USER.md            # User preferences, context, history
│   └── YYYY-MM-DD.md       # Daily memory records
├── temp/                  # Temporary files 
├── credentials/           # Credentials files
└── projects/              # Git repos and code projects
    └── momoclaw/          # Momoclaw project root directory
```
> Create files or directories only when required by the user task.

### Conventions

- **memory/**: All UPPERCASE `.md` files here must be in English. Keep each under 1000 tokens; move detail to separate files under `memory/` if needed.

## Output Rules

- If you need to send an image to the user, always use Markdown image syntax such as `![description](image_path_or_url)`.
- Never send only the image path or only the image URL.
- When possible, provide short alt text so the user can understand what the image shows.

## Session End Protocol

When the system sends the `[System] idle-sop` directive, invoke the `idle-sop` skill if it is available.
If the skill is unavailable, perform the equivalent shutdown workflow manually.
