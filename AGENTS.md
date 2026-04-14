# AGENTS.md

## Project: Sleep Code

**Code from your bed.** Monitor and control Claude Code sessions from Slack, Discord, or Telegram.

- **Repository**: https://github.com/cheeselemon/sleep-code
- **License**: MIT
- **Node**: >= 18.0.0
- **Language**: TypeScript 5.x (ES modules, strict mode)

## Build & Test

```bash
npm run build           # Build with tsup (required before running)
npm run dev             # Dev mode with tsx
```

No test suite yet. Validate changes by building successfully:

```bash
npm run build && echo "Build OK"
```

## Project Structure

```
src/
├── cli/                    # CLI entry point and commands
│   ├── index.ts            # Main CLI entry (commander.js)
│   ├── run.ts              # Session runner (PTY + Unix socket connection)
│   ├── hook.ts             # Claude Code permission hook handler
│   └── {telegram,discord,slack}.ts  # Platform-specific setup/run
├── discord/
│   ├── discord-app.ts      # Discord.js app, slash commands, button handlers
│   ├── channel-manager.ts  # Thread/channel management, session mapping
│   ├── process-manager.ts  # Session spawning, lifecycle, terminal window tracking
│   ├── settings-manager.ts # User settings (allowed directories, terminal app)
│   └── codex/              # Codex integration (session management, handlers)
├── slack/
│   ├── slack-app.ts        # Slack Bolt app and event handlers
│   └── session-manager.ts  # JSONL watching, session tracking (shared by all platforms)
└── telegram/
    └── telegram-app.ts     # grammY app and event handlers
```

## Key Dependencies

- `discord.js` ^14.x — Discord bot
- `@slack/bolt` ^4.x — Slack bot
- `grammy` ^1.x — Telegram bot
- `@openai/codex-sdk` ^0.104.x — Codex integration
- `node-pty` ^1.x — PTY spawning
- `chokidar` ^5.x — File watching
- `pino` ^10.x — Structured logging

## Code Style

- TypeScript with ES modules (`"type": "module"`)
- `async/await` for all async operations
- Pino for structured logging (`src/utils/logger.ts`)
- Error handling: catch and log, don't crash the bot
- No default exports — use named exports

## Git Workflow

- Branch from `main`
- Commit messages: concise, imperative mood
- PR title: under 70 characters
- Always run `npm run build` before committing

## How It Works

1. `npm run {platform}` starts a bot with a Unix socket daemon at `/tmp/sleep-code-daemon.sock`
2. `npm run claude` spawns Claude in a PTY and connects via socket
3. SessionManager watches Claude's JSONL files (`~/.claude/projects/*/{sessionId}.jsonl`)
4. Messages relay bidirectionally: JSONL → Bot → Chat, Chat → Bot → PTY
5. Permission requests forward to chat for interactive approval (buttons)

## Multi-Agent Workflow

This project uses a **Claude + Codex + Generic agent** collaboration model:

### Roles

- **Claude (Architect)** — Plans features, reviews code, makes architectural decisions
- **Codex (Implementer)** — Implements code based on plan files, executes tasks
- **Generic Agents** — Lightweight models for review, brainstorming, secondary opinions (Gemma 4, GLM-5, GLM-5.1, Qwen3 Coder via OpenRouter/DeepInfra)
- **CEO (Human)** — Final approval on plans and completed work

### Process

1. **Plan**: Claude creates a detailed plan file in `docs/plans/`
2. **Approve**: CEO reviews and approves the plan
3. **Implement**: Codex receives the plan filename and implements it
4. **Review**: Claude reviews the implementation
5. **Repeat**: Iterate until quality is met
6. **Ship**: CEO gives final approval

### Communication Protocol

- `CEO → Claude`: no prefix (regular message)
- `CEO → Codex`: starts with `@codex`
- `CEO → Generic`: starts with `@gemma4`, `@glm5`, `@glm51`, or `@qwen3-coder`
- `Claude → Codex`: starts with `@codex`
- `Codex → Claude`: starts with `@claude`
- `Agent → Agent`: include `@target_name` in output

Supported mentions: `@claude`, `@codex`, `@gemma4`, `@glm5`, `@glm51`, `@qwen3-coder`

**`@` Mention Rules (Critical — prevents infinite loops):**
- `@mention` = immediate delivery + the target agent starts working
- **Use `@mention` only when you have a concrete request, question, or task** for the other agent
- Acknowledgments, status updates, and completion reports go to the human (CEO) only (no `@mention`)
- When referring to another agent without routing, omit `@` (write "codex", "claude", "gemma4")
  - OK: "incorporated codex's feedback"
  - BAD: "incorporated @codex's feedback" — this triggers routing

### File-Based Context Sharing

Long messages may be truncated or fail in Discord routing. **Long context between agents must be shared via files**.

**Rules:**
1. Plans, reviews, reports, and any content 3+ lines long go in files under `docs/plans/`
2. Send only **file path + 1-2 line summary** to the other agent
3. The receiving agent reads the file and responds (adds a section or creates a separate file)
4. Codex may be in a read-only session — if file modification is needed, send content via message and Claude writes it to the file

**Example:**
```
@codex Read docs/plans/feature-plan.md and review it. Add your feedback at the bottom.
```

**File naming convention:**
- Plans: `docs/plans/<feature>-plan.md`
- Reports: `docs/plans/<feature>-report.md`
- Discussions: `docs/plans/<feature>-discussion.md`

### Plan File Convention

- Location: `docs/plans/<feature-name>.md`
- Include: goal, scope, affected files, step-by-step tasks, acceptance criteria
- Codex receives: plan filename + "implement this plan" instruction

## Boundaries

### Always Do

- Run `npm run build` to verify changes compile
- Follow existing patterns in nearby files
- Keep error handling consistent (catch + log, no crashes)

### Never Do

- Delete files without backup (see project policy)
- Use `rm -rf`, `git reset --hard`, `git clean -fd`
- Modify credentials or `.env` files
- Push directly to `main` without review
- Add dependencies without explicit approval
