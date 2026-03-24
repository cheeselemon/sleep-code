# Architecture

## Directory Structure

```
src/
├── cli/                    # CLI entry point and commands
│   ├── index.ts            # Main CLI entry (commander.js)
│   ├── run.ts              # Session runner (PTY + socket)
│   ├── hook.ts             # Permission hook handler
│   ├── memory.ts           # Memory CLI commands
│   └── {telegram,discord,slack}.ts
├── memory/                 # Semantic memory pipeline
│   ├── memory-service.ts       # LanceDB store, search, dedup, supersede
│   ├── memory-collector.ts     # Message ingestion with sliding window
│   ├── distill-service.ts      # LLM classifier (store/skip/update/resolve_task, open task injection, 2nd-pass review)
│   ├── batch-distill-runner.ts # Queue + timer + SDK session + consolidation scheduler + task resolution
│   ├── daily-digest.ts         # Scheduled digest briefings (Claude SDK sonnet, pre-consolidation)
│   ├── consolidation-service.ts # Periodic merge, cleanup, smart task auto-resolution (4 phases)
│   ├── task-rules.ts           # Shared task lifecycle rules (completion detection, classification)
│   ├── migrate-tasks.ts        # One-time LLM task review with git log cross-reference
│   ├── memory-config.ts        # JSON config loader with hot-reload (fs.watch)
│   ├── embedding-provider.ts   # Ollama embedding abstraction
│   └── chat-provider.ts        # LLM chat abstraction (Ollama/Claude CLI/Claude SDK)
├── mcp/
│   └── memory-server.ts        # MCP server (HTTP transport)
├── discord/
│   ├── discord-app.ts          # Discord.js app, event handlers
│   ├── channel-manager.ts      # Thread/channel management, session mapping
│   ├── process-manager.ts      # Session spawning, lifecycle
│   ├── settings-manager.ts     # User settings (directories, terminal app)
│   ├── memory-reporter.ts      # #sleep-code-memory channel management
│   ├── agent-routing.ts        # @codex/@claude message routing
│   ├── claude-sdk/
│   │   ├── claude-sdk-session-manager.ts  # SDK session lifecycle
│   │   └── claude-sdk-handlers.ts         # SDK event → Discord
│   └── codex/
│       ├── codex-session-manager.ts
│       └── codex-handlers.ts
├── shared/
│   └── session-manager.ts  # JSONL watching (shared across platforms)
├── slack/
│   └── slack-app.ts        # Slack Bolt app
└── telegram/
    └── telegram-app.ts     # grammY app

explorer/                   # Memory Explorer web app (Next.js 16)
```

## Data Flow

```
User (Discord/Slack/Telegram)
  │
  ▼
Chat Platform Bot
  │
  ├──► Unix Socket ──► PTY (Claude Code process)
  │                      │
  │                      ▼
  │                  JSONL log files (~/.claude/projects/*)
  │                      │
  │                      ▼
  │                  SessionManager (watches JSONL, relays messages)
  │
  └──► Claude Agent SDK query() ──► Claude Code (no terminal needed)
         │
         ▼
      canUseTool callback ──► Permission buttons (Allow/YOLO/Deny)
```

## Key Components

### SessionManager (`src/shared/session-manager.ts`)
Shared across all platforms. Watches Claude's JSONL files with chokidar, extracts messages and tool calls, handles deduplication, and forwards permission requests.

### ProcessManager (`src/discord/process-manager.ts`)
Discord-only. Spawns Claude sessions (background or terminal app), tracks process lifecycle, and manages terminal window IDs for proper cleanup.

### ChannelManager (`src/discord/channel-manager.ts`)
Discord-only. Creates dedicated channels per project CWD (`sleep-{foldername}`) inside "Sleep Code Sessions" category. Manages threads for each session, persists mappings to disk for bot restart recovery.

### ClaudeSdkSessionManager (`src/discord/claude-sdk/`)
Runs Claude Code via the Agent SDK `query()` API — no terminal window needed. Async generator prompt input, `canUseTool` callback for permission handling, session resume from JSONL history.

### BatchDistillRunner (`src/memory/batch-distill-runner.ts`)
Queues messages and processes them in batches via a persistent Claude SDK session. Handles batch timer, session refresh, consolidation scheduling, opt-out tracking, and config hot-reload.

### MemoryReporter (`src/discord/memory-reporter.ts`)
Manages `#sleep-code-memory` channel. Creates daily distill threads, weekly consolidation threads, and posts batch results + digest briefings.

## Config & Data Files

| Path | Purpose |
|------|---------|
| `~/.sleep-code/discord.env` | Discord bot token + user ID |
| `~/.sleep-code/slack.env` | Slack tokens |
| `~/.sleep-code/settings.json` | Allowed dirs, terminal app, maxConcurrentSessions |
| `~/.sleep-code/memory-config.json` | Memory system configuration (hot-reloaded) |
| `~/.sleep-code/digest-prompt.txt` | Custom daily digest prompt template |
| `~/.sleep-code/process-registry.json` | ProcessManager session registry |
| `~/.sleep-code/session-mappings.json` | PTY session → Discord thread mappings |
| `~/.sleep-code/sdk-session-mappings.json` | SDK session → Discord thread mappings |
| `~/.sleep-code/codex-session-mappings.json` | Codex session → Discord thread mappings |
| `~/.sleep-code/memory/lancedb/` | LanceDB vector store |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` / `DISCORD_USER_ID` | Discord credentials |
| `OPENAI_API_KEY` | Enables Codex integration |
| `DISABLE_MEMORY` | Set `1` to skip memory collector |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_USER_ID` | Slack credentials |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram credentials |
| `MCP_PORT` | MCP server port (default: 24242) |
| `LOG_LEVEL` | Pino log level (default: info) |

## Code Style

- TypeScript with ES modules
- Async/await for all async operations
- Pino for structured logging (`src/utils/logger.ts`)
- Error handling: catch and log, don't crash the bot
