# Architecture

## Directory Structure

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
│   ├── consolidation-service.ts # Periodic merge, cleanup, smart task auto-resolution (4 phases)
│   ├── task-rules.ts           # Shared task lifecycle rules (completion detection, classification)
│   ├── migrate-tasks.ts        # One-time LLM task review with git log cross-reference
│   ├── memory-config.ts        # JSON config loader with hot-reload (fs.watch)
│   ├── embedding-provider.ts   # Ollama embedding abstraction
│   └── chat-provider.ts        # LLM chat abstraction (Ollama/Claude CLI/Claude SDK)
├── mcp/
│   └── memory-server.ts        # MCP server (HTTP transport, memory tools)
├── discord/
│   ├── discord-app.ts          # Discord.js app, event routing, memory system init
│   ├── channel-manager.ts      # Thread/channel management, session mapping (uses SessionStore)
│   ├── session-store.ts        # Generic session persistence (Map + JSON file + thread routing)
│   ├── control-panel.ts        # #sleep-code-control channel with Interrupt All button
│   ├── process-manager.ts      # Session spawning, lifecycle, terminal window tracking
│   ├── settings-manager.ts     # User settings (directories, terminal app)
│   ├── memory-reporter.ts      # #sleep-code-memory channel, daily/weekly threads
│   ├── state.ts                # Shared state (permissions, YOLO, routing)
│   ├── utils.ts                # Message routing, attachment handling
│   ├── commands/               # Slash command handlers (claude, codex, memory, settings, etc.)
│   ├── handlers/               # SessionManager callback handlers
│   ├── interactions/           # Button, select menu, modal handlers (ask-question-factory.ts for shared logic)
│   ├── claude-sdk/
│   │   ├── claude-sdk-session-manager.ts  # SDK session lifecycle, query stream
│   │   └── claude-sdk-handlers.ts         # SDK event → Discord message handlers
│   └── codex/
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
Runs Claude Code via the Agent SDK `query()` API — no terminal window needed. Async generator prompt input, `canUseTool` callback for permission handling, session resume from JSONL history, and model + context window selection persisted for restart.

### BatchDistillRunner (`src/memory/batch-distill-runner.ts`)
Queues messages and processes them in batches via a persistent Claude SDK session. Handles batch timer, session refresh, consolidation scheduling, opt-out tracking, and config hot-reload.

### MemoryReporter (`src/discord/memory-reporter.ts`)
Manages `#sleep-code-memory` channel. Creates daily distill threads, weekly consolidation threads, and posts batch results + digest briefings.

## Config, Environment Variables, Code Style

See [CLAUDE.md](../CLAUDE.md) for the canonical reference on config files, environment variables, and code style.
