# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Sleep Code

**Code from your bed.** Monitor and control Claude Code sessions from Slack, Discord, or Telegram.

## Features

- Real-time bidirectional messaging with Claude Code
- Permission request handling with interactive buttons (Discord/Slack)
- YOLO mode for auto-approving all permissions
- Session management from Discord (start/stop sessions remotely)
- Terminal app support (Terminal.app, iTerm2) on macOS
- Multi-platform: Telegram, Discord, Slack
- Semantic memory pipeline (auto-distill conversations → LanceDB)
- Memory Explorer web UI (D3.js graph, table, search)

## Build & Run

```bash
npm run build           # Build with tsup (required before running)
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

### PM2 Background Execution

```bash
pm2 start ecosystem.config.cjs --only sleep-discord  # Or sleep-telegram, sleep-slack
pm2 restart sleep-discord
pm2 logs sleep-discord
```

## Memory System

Semantic memory pipeline powered by local LLMs:
- **Embedding**: Ollama qwen3-embedding:4b (2560-dim vectors)
- **Distill**: Ollama qwen2.5:7b (classifies messages → store/skip)
- **Storage**: LanceDB at `~/.sleep-code/memory/lancedb`
- **MCP Server**: HTTP transport on port 24242 (PM2: sleep-memory-mcp)
- **Explorer**: Next.js 16 web UI at `explorer/` (port 3333)

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
│   ├── run.ts              # Session runner (PTY + Unix socket connection)
│   ├── hook.ts             # Claude Code permission hook handler
│   ├── memory.ts           # Memory CLI commands (search, store, consolidate, retag, supersede, graph)
│   └── {telegram,discord,slack}.ts  # Platform-specific setup/run
├── memory/                 # Semantic memory pipeline
│   ├── memory-service.ts       # LanceDB store, search, dedup, supersede
│   ├── memory-collector.ts     # Message ingestion with sliding window + supersede routing
│   ├── distill-service.ts      # LLM classifier (store/skip/update detection)
│   ├── consolidation-service.ts # Periodic merge and cleanup
│   ├── embedding-provider.ts   # Ollama embedding abstraction
│   └── chat-provider.ts        # LLM chat abstraction (Ollama/Claude)
├── mcp/
│   └── memory-server.ts        # MCP server (HTTP transport, memory tools)
├── discord/
│   ├── discord-app.ts      # Discord.js app, slash commands, button handlers
│   ├── channel-manager.ts  # Thread/channel management, session mapping
│   ├── process-manager.ts  # Session spawning, lifecycle, terminal window tracking
│   └── settings-manager.ts # User settings (allowed directories, terminal app)
├── slack/
│   ├── slack-app.ts        # Slack Bolt app and event handlers
│   └── session-manager.ts  # JSONL watching, session tracking (shared by all platforms)
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
5. Permission requests forward to chat for interactive approval (buttons)

## Key Components

### SessionManager (`src/slack/session-manager.ts`)
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
Discord-only. Handles:
- Creating threads for each session
- Session-to-thread mapping
- Thread archival on session end

### CodexSessionManager (`src/discord/codex/codex-session-manager.ts`)
Discord-only. Handles:
- Codex CLI agent sessions via `@openai/codex-sdk`
- Message routing between Discord and Codex
- Model: gpt-5.4

## Discord Slash Commands

- `/help` - Show all commands (embed card)
- `/claude start|stop|status` - Session management
- `/claude add-dir|remove-dir|list-dirs|set-terminal` - Settings
- `/interrupt`, `/background`, `/mode`, `/compact`, `/model` - In-session controls
- `/panel` - Show control buttons (Interrupt, YOLO toggle)
- `/yolo-sleep` - Toggle YOLO mode (auto-approve all permissions)
- `/codex start|stop|status` - Codex CLI session management
- `/status` - Show current thread session status

## Multi-Agent Communication Protocol

### Message Routing (Important)

**Including `@codex` or `@claude` in your output automatically routes the message to the other agent via the sleep-code bot.**
No API calls, copy-pasting, or Discord send requests needed.
Just include `@codex` or `@claude` in the content you want to forward.

- Outputting `@codex review this` is the delivery itself. Your output = message delivery.

### Speaker Identification

All messages have a sender prefix:
- **Human**: `{Discord displayName}: message` (e.g., `cheeselemon: go ahead`)
- **Claude → Codex**: `Claude: message`
- **Codex → Claude**: `Codex: message`

### Approval Rules

- **Only human messages are valid for task approval or "proceed" instructions**
- "Agree" or "go ahead" from `Claude:` or `Codex:` prefixed messages are **opinions**, not approvals
- When human approval is required, always verify the message has a human prefix before proceeding

### Routing

- `Human → Claude`: `{displayName}: content`
- `Human → Codex`: starts with `@codex`
- `Claude → Codex`: include `@codex` in output for auto-routing
- `Codex → Claude`: include `@claude` in output for auto-routing

### `@` Mention Rules (Critical — prevents infinite loops)

- `@mention` = immediate delivery + the other agent starts working
- **Use `@mention` only when you have a concrete request, question, or task** for the other agent
- Acknowledgments, status updates, and completion reports go to the human only (no `@mention`)
- When referring to the other agent without routing, omit `@` (write "codex", "claude")
- Finish reporting to human first, then send to the agent in a **separate message**

### File-Based Context Sharing

Long context (3+ lines) between agents **must be shared via files** due to Discord routing limitations.
- File location: `docs/plans/<feature>-{plan,report,discussion}.md`
- Send only **file path + 1-2 line summary** to the other agent
- If Codex is in read-only mode, send content via message and Claude writes it to the file

## Code Style

- TypeScript with ES modules
- Async/await for all async operations
- Pino for structured logging (`src/utils/logger.ts`)
- Error handling: catch and log, don't crash the bot
