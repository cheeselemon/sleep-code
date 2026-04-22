# AGENTS.md

This file guides AI coding agents (Claude Code, OpenAI Codex, and other [agents.md](https://agents.md/)-compatible tools) when working with code in this repository. `CLAUDE.md` is a symlink to this file — edit here, not there.

## Critical Rules

- **NEVER restart the Discord bot server (pm2 restart) unless the user EXPLICITLY says "재시작", "restart", or "서버 재시작".** Build alone is fine. Restart is NOT implied by build, commit, or any other command.
- **Never run destructive commands** (`rm -rf`, `git reset --hard`, `git clean -fd`, `git checkout -- .`). Back up files with MD5 verification before any deletion; backups live in `~/.claude/backup/`.
- **Do not modify credentials or `.env` files** without an explicit instruction.
- **Do not push to `main` without review**, and never force-push.
- **Do not add dependencies** without explicit approval.

## Project: Sleep Code

**Code from your bed.** Monitor and control Claude Code sessions from Slack, Discord, or Telegram.

- **Repository**: https://github.com/cheeselemon/sleep-code
- **License**: MIT
- **Node**: >= 18.0.0
- **Language**: TypeScript 5.x (ES modules, strict mode)

## Features

- Real-time bidirectional messaging with Claude Code
- Permission request handling with interactive buttons (Discord/Slack)
- YOLO mode for auto-approving all permissions
- Session management from Discord (start/stop/restore sessions remotely)
- Session restore: PTY via `/claude restore`, SDK via lazy resume (auto-resumes on next message after bot restart)
- Terminal app support (Terminal.app, iTerm2) on macOS
- Multi-platform: Telegram, Discord, Slack
- Semantic memory pipeline (auto-distill conversations → LanceDB)
- Memory Explorer web UI (D3.js graph, table, search)

## Build & Run

```bash
npm run build           # Build with tsup (required before running)
npm run dev             # Dev mode with tsx
npm run discord:setup   # Configure Discord credentials
npm run discord         # Start the Discord bot
npm run telegram:setup  # Configure Telegram credentials
npm run telegram        # Start the Telegram bot
npm run slack:setup     # Configure Slack credentials
npm run slack           # Start the Slack bot
npm run claude          # Start a monitored Claude Code session
npm run explorer        # Start Memory Explorer web UI (port 3333)
npm run memory-server   # Start MCP memory server
```

No test suite yet. Validate changes by building successfully:

```bash
npm run build && echo "Build OK"
```

### PM2 Background Execution

```bash
pm2 start ecosystem.config.cjs --only sleep-discord  # Or sleep-telegram, sleep-slack, sleep-memory-mcp
pm2 restart sleep-discord
pm2 logs sleep-discord
```

## Key Dependencies

- `discord.js` ^14.x — Discord bot
- `@slack/bolt` ^4.x — Slack bot
- `grammy` ^1.x — Telegram bot
- `@anthropic-ai/claude-agent-sdk` ^0.2.x — Claude Agent SDK (in-process sessions)
- `@openai/codex-sdk` ^0.104.x — Codex integration
- `node-pty` ^1.x — PTY spawning
- `chokidar` ^5.x — File watching
- `pino` ^10.x — Structured logging

## Memory System

Semantic memory pipeline:
- **Embedding**: Ollama qwen3-embedding:4b (2560-dim vectors)
- **Distill**: Claude Agent SDK haiku via `BatchDistillRunner` (batch classification → store/skip/update/resolve_task + open task injection + 2nd-pass review)
- **Daily Digest**: Claude SDK sonnet generates scheduled briefings (default 10:00, 16:00 KST) with pre-consolidation; customizable via `~/.sleep-code/digest-prompt.txt`
- **Consolidation**: Auto-runs every 24h + pre-digest (4 phases: topicKey merge, vector merge, lifecycle cleanup, smart task auto-resolution)
- **Task Migration**: One-time LLM review of open tasks with git log cross-reference (`src/memory/migrate-tasks.ts`)
- **Config**: `~/.sleep-code/memory-config.json` (hot-reloaded)
- **Storage**: LanceDB at `~/.sleep-code/memory/lancedb`
- **MCP Server**: HTTP transport on port 24242 (PM2: sleep-memory-mcp, env: `MCP_PORT`)
- **MCP Tools**: `sc_memory_search`, `sc_memory_list`, `sc_memory_store`, `sc_memory_update`, `sc_memory_supersede`, `sc_memory_delete`
- **Explorer**: Next.js 16 web UI at `explorer/` (port 3333)
- **Discord**: `#sleep-code-memory` channel with daily distill threads + weekly consolidation threads

### Memory CLI

```bash
sleep-code memory search <query> [--project <name>]
sleep-code memory store <text> [--project <name>] [--kind <kind>]
sleep-code memory delete <id>
sleep-code memory consolidate [--project <name>] [--dry-run]
sleep-code memory graph [--project <name>] [--threshold 0.7]
sleep-code memory retag [--project <name>] [--dry-run]
sleep-code memory supersede <oldId> <newId>
sleep-code memory unsupersede <id>
sleep-code memory distill-test
sleep-code memory stats <project>
```

## Architecture

```
src/
├── cli/                    # CLI entry point and commands
│   ├── index.ts            # Main CLI entry (commander.js)
│   ├── run.ts              # Session runner (PTY + socket, CJK-safe chunked input, reconnect backoff)
│   ├── hook.ts             # Claude Code permission hook handler (writes to ~/.claude/settings.json)
│   ├── memory.ts           # Memory CLI commands (search, store, consolidate, retag, supersede, graph)
│   └── {telegram,discord,slack}.ts  # Platform-specific setup/run
├── memory/                 # Semantic memory pipeline
│   ├── memory-service.ts       # LanceDB store, search, dedup, supersede
│   ├── memory-collector.ts     # Message ingestion with sliding window, batch delegation
│   ├── distill-service.ts      # LLM classifier (store/skip/update/resolve_task, open task injection, 2nd-pass review)
│   ├── batch-distill-runner.ts # Queue + timer + SDK session + consolidation scheduler + task resolution
│   ├── daily-digest.ts         # Scheduled digest briefings (Claude SDK sonnet, pre-consolidation)
│   ├── memory-config.ts        # JSON config loader with hot-reload (fs.watch)
│   ├── consolidation-service.ts # Periodic merge, cleanup, smart task auto-resolution (4 phases)
│   ├── task-rules.ts           # Shared task lifecycle rules (completion detection, classification)
│   ├── migrate-tasks.ts        # One-time LLM task review with git log cross-reference
│   ├── embedding-provider.ts   # Ollama embedding abstraction
│   ├── chat-provider.ts        # LLM chat abstraction (Ollama/Claude CLI/Claude SDK)
├── mcp/
│   └── memory-server.ts        # MCP server (HTTP transport, memory tools)
├── discord/
│   ├── discord-app.ts      # Discord.js app, event routing, memory system init
│   ├── channel-manager.ts  # Thread/channel management, session mapping (uses SessionStore)
│   ├── session-store.ts    # Generic session persistence (Map + JSON file + thread routing)
│   ├── control-panel.ts    # #sleep-code-control channel with Interrupt All button
│   ├── process-manager.ts  # Session spawning, lifecycle, terminal window tracking
│   ├── settings-manager.ts # User settings (allowed directories, terminal app)
│   ├── memory-reporter.ts  # #sleep-code-memory channel, daily/weekly threads
│   ├── state.ts            # Shared state (permissions, YOLO, routing)
│   ├── utils.ts            # Message routing, attachment handling
│   ├── commands/           # Slash command handlers (claude, codex, memory, settings, etc.)
│   ├── handlers/           # SessionManager callback handlers
│   ├── interactions/       # Button, select menu, modal handlers (ask-question-factory.ts for shared logic)
│   ├── claude-sdk/         # Claude Agent SDK integration
│   │   ├── claude-sdk-session-manager.ts  # SDK session lifecycle, query stream
│   │   └── claude-sdk-handlers.ts         # SDK event → Discord message handlers
│   └── codex/              # Codex CLI agent integration
│       ├── codex-session-manager.ts
│       └── codex-handlers.ts
├── shared/
│   └── session-manager.ts  # JSONL watching, session tracking (shared by all platforms)
├── slack/
│   ├── slack-app.ts        # Slack Bolt app and event handlers
│   └── session-manager.ts  # Stub (moved to src/shared/session-manager.ts)
└── telegram/
    └── telegram-app.ts     # grammY app and event handlers

explorer/                   # Memory Explorer web app (Next.js 16)
├── src/app/                # Pages: dashboard, graph, memories
├── src/app/api/            # API routes: projects, memories, search, graph, stats
├── src/components/         # MemoryGraph (D3.js), MemoryTable, SearchBar
└── src/lib/memory.ts       # MemoryService singleton
```

## How It Works

1. `npm run {platform}` starts a bot with a Unix socket daemon at `/tmp/sleep-code-daemon.sock`
2. `npm run claude` spawns Claude in a PTY and connects via socket
3. SessionManager watches Claude's JSONL files (`~/.claude/projects/*/{sessionId}.jsonl`)
4. Messages relay bidirectionally: JSONL → Bot → Chat, Chat → Bot → PTY
5. Permission requests forward to chat for interactive approval (Allow / YOLO / Deny buttons)
6. On bot restart:
   - PTY sessions: waits 35s for CLI reconnection, then reconciles orphaned sessions
   - SDK sessions: persisted mappings restored to memory on load; lazy resume on next user message (loads JSONL history, reconnects SDK query stream)

## Key Components

### SessionManager (`src/shared/session-manager.ts`)
Shared across all platforms. Handles:
- JSONL file watching with chokidar
- Message deduplication
- Tool call/result extraction
- Permission request forwarding
- Session lifecycle events

### ProcessManager (`src/discord/process-manager.ts`)
Discord-only. Handles:
- Spawning Claude sessions (background or terminal app)
- Process lifecycle (start, stop, health checks)
- Terminal window ID tracking for proper cleanup
- Registry persistence (`~/.sleep-code/process-registry.json`)

### ChannelManager (`src/discord/channel-manager.ts`)
Discord-only. Uses `SessionStore` (generic persistence class) for PTY/Codex/SDK sessions:
- Creating dedicated text channels per CWD (`sleep-{foldername}`) inside "Sleep Code Sessions" category
- Creating threads for each session within the channel
- Three `SessionStore` instances handle persistence + thread routing for each session type
- SDK session mapping with lazy resume support (`~/.sleep-code/sdk-session-mappings.json`)
  - Tracks `sessionId` (internal) vs `sdkSessionId` (Claude Agent SDK) separately
  - Persists `sdkModel` so lazy resume restores the same model + context window
  - Restores in-memory maps on bot startup for message routing
  - Deduplicates and cleans broken mappings on load (skips `sdkSessionId === sessionId`)
- Thread archival on session end

### ClaudeSdkSessionManager (`src/discord/claude-sdk/claude-sdk-session-manager.ts`)
Discord-only. Handles:
- Claude Agent SDK sessions via `@anthropic-ai/claude-agent-sdk` `query()` API
- Model + context window selection at session start (Opus 4.7/4.6, Sonnet 4.6, Haiku 4.5; 200K/1M where supported)
- Async generator prompt input + async iterable output stream
- `canUseTool` callback for permission handling (Allow/YOLO/Deny) + AskUserQuestion interactive UI
- Session resume from JSONL history (`resume: sdkSessionId`)
- Lazy resume: auto-resumes on first message after bot restart (no liveness check deadlock)
- Duplicate session guards (by ID and by thread)
- Graceful shutdown: preserves SDK mappings for lazy resume on restart
- Per-turn token usage tracking and cost reporting with primary model pinned to the user's `/claude start-sdk` selection (falls back to highest-token model only if the selected one is absent that turn) + full breakdown
- Loads CLAUDE.md and user/project settings via `settingSources: ['user', 'project', 'local']`

### CodexSessionManager (`src/discord/codex/codex-session-manager.ts`)
Discord-only. Handles:
- Codex CLI agent sessions via `@openai/codex-sdk`
- Message routing between Discord and Codex
- Model: gpt-5.4, approval_policy: 'never' (no permission prompts)
- Auto-detected when `~/.codex/auth.json` exists or `OPENAI_API_KEY` is set
- Sandbox: `read-only` by default, switches to `workspace-write` when YOLO enabled
- Session persistence: `codexThreadId` saved after first turn, `resumeThread()` for restore after bot restart
- Sandbox mode switch triggers thread re-creation/resume

## Discord Interactive Features

- **Permission buttons**: Allow / YOLO (enables auto-approve) / Deny — YOLO also switches Codex to `workspace-write`
- **AskUserQuestion**: Renders interactive buttons (single-select) or select menus (multi-select) with "Other..." modal for custom input
- **View Full**: Tool results > 300 chars are truncated with a "View Full" button → sends `.txt` file attachment
- **File upload on Write/Edit**: Modified files auto-upload as Discord attachments
- **Image auto-upload**: Image paths (`.png`, `.jpg`, etc.) in Claude's output auto-upload as attachments
- **Text file input**: Users can attach `.txt` files to messages → injected into Claude session (max 100KB)
- **Typing indicator**: Shown every 8s while Claude session is running
- **Plan mode notifications**: Posts messages when Claude enters/exits plan mode
- **Control panel**: `#sleep-code-control` channel with persistent Interrupt All button (interrupts all running SDK/PTY/Codex sessions)
- **Token usage**: Per-turn context usage and cost displayed after each SDK response
- **Session start pin**: SDK new thread creation pins the "Session Starting" message
- **Message debounce**: User messages batched with 3s window before sending to agent (multi-message input)
- **Network watchdog**: Polls IP fingerprint every 5s, auto-recovers on VPN/WiFi switch (10s grace → PM2 restart)
- **Session auto-restart**: Resume failure (expired conversation) → auto-creates fresh session with same CWD
- **Digest Done buttons**: Mark tasks as resolved directly from digest messages

## Discord Slash Commands

- `/help` - Show all commands (embed card)
- `/claude start|start-sdk|stop|status|restore` - Session management
- `/claude add-dir|remove-dir|list-dirs|set-terminal` - Settings
- `/interrupt`, `/background`, `/mode`, `/compact`, `/model` - In-session controls
- `/panel` - Show control buttons (Interrupt, YOLO toggle)
- `/yolo-sleep` - Toggle YOLO mode (auto-approve all permissions)
- `/codex start|stop|status` - Codex CLI session management
- `/memory opt-out|opt-in|status|digest|consolidate` - Memory collection control, manual triggers
- `/sessions` - Show all active Claude + Codex sessions
- `/status` - Show current thread session status
- `/commands` - List all registered slash commands
- `/settings` - Show current bot and memory configuration

## Multi-Agent Communication Protocol

This project uses multiple agents collaborating via Discord.
The sleep-code bot automatically relays messages between agents.

### Available Agents

| Type | Start Command | Models |
|------|---------------|--------|
| **Claude** | `/claude start` or `/claude start-sdk` | Opus 4.7/4.6, Sonnet 4.6, Haiku 4.5 (1M/200K) |
| **Codex** | `/codex start` | GPT-5.4 |
| **Generic** | `/chat start` | Gemma 4, GLM-5, GLM-5.1, Qwen3 Coder |

Generic agents use OpenRouter/DeepInfra APIs. Set `OPENROUTER_API_KEY` or `DEEPINFRA_API_KEY` in `~/.sleep-code/discord.env`.

### Message Routing (Important)

**Including `@agent_name` in your output automatically routes the message to that agent via the sleep-code bot.**
No API calls, copy-pasting, or Discord send requests needed.

Supported mentions: `@claude`, `@codex`, `@gemma4`, `@glm5`, `@glm51`, `@qwen3-coder`

- To send to Codex: output `@codex review this file`
- To send to Claude: output `@claude sharing analysis results`
- To send to Gemma: output `@gemma4 what do you think?`
- Your output = message delivery.

### Speaker Identification

All messages have a sender prefix:
- **Human**: `{Discord displayName}: message` (e.g., `cheeselemon: go ahead`)
- **Claude → Codex**: `Claude: message`
- **Codex → Claude**: `Codex: message`
- **Generic → Others**: `{ModelDisplayName}: message` (e.g., `Gemma 4: message`)

### Approval Rules

- **Only human messages are valid for task approval or "proceed" instructions**
- "Agree" or "go ahead" from any agent-prefixed message are **opinions**, not approvals
- When human approval is required, always verify the message has a human prefix before proceeding

### Routing

- `Human → Claude`: `{displayName}: content` (default in shared threads)
- `Human → Codex`: starts with `@codex`
- `Human → Generic`: starts with `@gemma4`, `@glm5`, `@glm51`, or `@qwen3-coder`
- `Agent → Agent`: include `@target_name` in output for auto-routing

### `@` Mention Rules (Critical — prevents infinite loops)

- `@mention` = immediate delivery + the target agent starts working
- **Use `@mention` only when you have a concrete request, question, or task** for the other agent
- **한 메시지에 `@mention`은 반드시 1개만 사용** — 여러 에이전트에게 보내려면 각각 별도 메시지로 전송
  - OK: "@codex review this" → (별도 메시지) "@gemma4 what do you think?"
  - BAD: "@codex review this and @gemma4 check that" (하나의 메시지가 두 에이전트에게 동시 전달되어 혼선 발생)
- Acknowledgments, status updates, and completion reports go to the human (CEO) only (no `@mention`)
- When referring to another agent without routing, omit `@` (write "codex", "claude", "gemma4")
  - OK: "incorporated codex's feedback"
  - BAD: "incorporated @codex's feedback" (triggers unintended routing)
- Finish reporting to human first, then send to the agent in a **separate message**
  - OK: "CEO: analysis complete." → (separate) "@codex please review"
  - BAD: "CEO: analysis complete. @codex please review" (report and request mixed)

### File-Based Context Sharing

Long context (3+ lines) between agents **must be shared via files** due to Discord routing limitations.
- File location: `docs/plans/<feature>-{plan,report,discussion}.md`
- Send only **file path + 1-2 line summary** to the other agent
- If Codex is in read-only mode, send content via message and Claude writes it to the file

### Plan File Structure

Plan files under `docs/plans/` should include:
- **Goal** — what we want to accomplish and why
- **Scope** — what's in and what's out
- **Affected files** — paths the change will touch
- **Step-by-step tasks** — ordered checklist
- **Acceptance criteria** — how we'll know it's done

Receiving agent workflow: plan filename + "implement this plan" instruction → read the file, implement, append report section at the bottom or create `<feature>-report.md` alongside.

## File Delivery via `<attach>` Marker

In Claude SDK sessions, an AI agent can offer a file for manual delivery by including an XML marker in its response:

```xml
<attach>/absolute/path/to/file.pdf</attach>
```

Rules:
- SDK sessions only. PTY Claude sessions and Codex sessions do not render attach buttons in the current implementation.
- Use an absolute path only.
- The file must stay inside the session CWD after `path.resolve()` and `fs.realpathSync()` validation.
- Up to 5 markers per response are rendered as Discord buttons.
- The user must click the button to receive the file. The bot does not auto-upload from path mentions alone.
- Buttons expire after 1 hour.
- Re-clicking an already delivered file returns the existing upload link instead of uploading again.
- Files larger than 25MB are rejected at click time.
- Prefer adding a short human explanation next to the marker so the user knows what the file is.

## Memory & Knowledge System

Conversations in this project are automatically remembered by the sleep-code memory pipeline.

### How It Works
1. Discord/terminal conversations are collected in real-time
2. A local LLM (Ollama qwen2.5:7b) classifies each message — distills it if worth remembering
3. Stored in LanceDB with vector embeddings (separated by project)
4. Duplicate memories are auto-merged (cosine similarity >= 0.85)

### What Gets Stored
- **decision**: Key decisions (e.g., "Refund penalty waived within 30 days of contract date")
- **fact**: Confirmed facts (e.g., "Not using API SDK due to cost")
- **preference**: Preferences/policies (e.g., "Use only Ollama local models")
- **task**: Assigned tasks
- **proposal**: Proposals and suggestions
- **feedback**: User feedback

Each memory is tagged with project, speaker, priority (0-10), and topicKey.

### Usage (MCP Tools)
- `sc_memory_search` — Semantic search. Returns relevant memories for queries like "what did we decide about refund logic?"
- `sc_memory_list` — List recent memories for the project
- `sc_memory_store` — Only use when the user explicitly requests it (e.g., "remember this", "store this")

### Project Settings
- project name: `sleep-code`
- Search example: `sc_memory_search(query="...", project="sleep-code")`

## Config & Data Files

| Path | Purpose |
|------|---------|
| `~/.sleep-code/discord.env` | Discord bot token + user ID |
| `~/.sleep-code/slack.env` | Slack tokens |
| `~/.sleep-code/settings.json` | Allowed dirs, terminal app, maxConcurrentSessions |
| `~/.sleep-code/process-registry.json` | ProcessManager session registry |
| `~/.sleep-code/session-mappings.json` | Claude session → Discord thread mappings |
| `~/.sleep-code/codex-session-mappings.json` | Codex session → Discord thread mappings |
| `~/.sleep-code/sdk-session-mappings.json` | Claude SDK session → Discord thread + sdkSessionId mappings |
| `~/.sleep-code/memory-config.json` | Memory system config (distill, consolidation, digest) — hot-reloaded |
| `~/.sleep-code/digest-prompt.txt` | Custom daily digest prompt template (optional) |
| `~/.sleep-code/memory/lancedb/` | LanceDB vector store |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` / `DISCORD_USER_ID` | Discord credentials (overrides config) |
| `OPENAI_API_KEY` | Enables Codex integration |
| `DISABLE_MEMORY` | Set `1` to skip memory collector |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_USER_ID` | Slack credentials |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram credentials |
| `MCP_PORT` | MCP server port (default: 24242) |
| `LOG_LEVEL` | Pino log level (default: info) |

## Documentation

- 문서 작성/수정 시 `/write-docs` 스킬을 사용하여 `docs/writing-guide.md`의 5원칙을 적용
- 정본(canonical) 위치: 에이전트 지침·아키텍처·환경변수는 `AGENTS.md` (CLAUDE.md는 심볼릭 링크), 커맨드는 `docs/commands.md`, 메모리는 `docs/memory.md`

## Skills (Slash Commands)

스킬 파일은 3곳에 존재하며 **수정 시 반드시 3곳 동기화**:

| 역할 | 위치 | 설명 |
|------|------|------|
| 정본 (Source) | `docs/skills/*.md` | 레포에 커밋되는 원본 |
| 설치 스킬 | `.claude/commands/sc-install.md` | 정본을 `~/.claude/commands/`로 복사하는 스킬 |
| 설치된 사본 | `~/.claude/commands/sc-*.md` | 실제 실행되는 사본 (레포 밖) |

스킬 내용을 수정할 때:
1. `docs/skills/` 정본을 먼저 수정
2. `~/.claude/commands/sc-*` 사본에 동일 내용 반영
3. `.claude/commands/sc-install.md` 안내 문구도 맞춰 수정

## Code Style

- TypeScript with ES modules (`"type": "module"`)
- Async/await for all async operations
- Named exports only — no default exports
- Pino for structured logging (`src/utils/logger.ts`)
- Error handling: catch and log, don't crash the bot

## Git Workflow

- Branch from `main`
- Commit messages: concise, imperative mood
- PR title: under 70 characters
- Always run `npm run build` before committing
- Never push directly to `main` without review; never force-push

## File Layout Convention

- `AGENTS.md` (this file) — canonical agent instructions, open [agents.md](https://agents.md/) standard
- `CLAUDE.md` — symlink to `AGENTS.md` (Claude Code reads this name natively)
- Edit `AGENTS.md`; `CLAUDE.md` stays in sync automatically via the symlink
