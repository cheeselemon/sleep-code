# Sleep Code

[English](README.md) | [한국어](README.ko.md)

**Code from your bed.** Monitor and control Claude Code sessions from Slack, Discord, or Telegram.

<p align="center">
  <img width="512" height="512" alt="Sleep Code Logo" src="https://github.com/user-attachments/assets/2e82e717-c957-4be3-827c-f03e22cfaa07" />
</p>

## See Also

**Using OpenCode instead of Claude Code?** Check out [Disunday](https://github.com/code-xhyun/disunday) - a Discord bot that lets you control OpenCode coding sessions from Discord. Same concept, different AI backend.

## Features

- **Real-time messaging** - Send and receive messages to/from Claude Code
- **Permission handling** - Approve or deny tool permissions from chat (Discord)
- **YOLO mode** - Auto-approve all permission requests
- **Session management** - Start, stop, and monitor sessions from Discord
- **Codex integration** - Run OpenAI Codex sessions alongside Claude in the same thread
- **Terminal app support** - Open sessions in Terminal.app or iTerm2 (macOS)
- **Multi-platform** - Works with Telegram, Discord, and Slack
- **Semantic memory** - Auto-distills conversations into a local vector DB (LanceDB + Ollama), searchable via MCP

## Platform Comparison

| | Telegram | Discord | Slack |
|---|---|---|---|
| Siri integration | Receive & Send | Receive only | Receive only |
| Multi-session support | One at a time (switchable) | Yes | Yes |
| Permission handling | - | Yes (buttons) | Yes (buttons) |
| Session management | - | Yes (start/stop from chat) | - |
| Permissions required | Personal | Personal | Admin |

**Recommended:** Discord for full features, Telegram for Siri integration.

## Quick Start (Discord)

```bash
# 1. Create a Discord app at https://discord.com/developers/applications
#    - Go to Bot → Reset Token → copy it
#    - Enable "Message Content Intent"
#    - Go to OAuth2 → URL Generator → select "bot" scope
#    - Select permissions: Send Messages, Manage Channels, Read Message History
#    - Open the generated URL to invite the bot

# 2. Get your User ID (enable Developer Mode, right-click your name → Copy User ID)

# 3. Clone and setup
git clone https://github.com/cheeselemon/sleep-code.git
cd sleep-code && npm install && npm run build

# 4. Configure and run
npm run discord:setup   # Enter your credentials
npm run discord         # Start the bot

# 5. Configure the permission hook
npm run hook:setup

# 6. In another terminal, start a monitored Claude session
npm run claude
```

## Quick Start (Telegram)

```bash
# 1. Create a bot with @BotFather on Telegram
#    - Send /newbot and follow the prompts
#    - Copy the bot token

# 2. Get your Chat ID
#    - Message your bot, then visit:
#    - https://api.telegram.org/bot<TOKEN>/getUpdates
#    - Find "chat":{"id":YOUR_CHAT_ID}

# 3. Configure and run
npm run telegram:setup   # Enter your credentials
npm run telegram         # Start the bot

# 4. In another terminal, start a monitored Claude session
npm run claude
```

## Quick Start (Slack)

```bash
# 1. Create a Slack app at https://api.slack.com/apps
#    Click "Create New App" → "From manifest" → paste slack-manifest.json

# 2. Install to your workspace and get credentials:
#    - Bot Token (xoxb-...) from OAuth & Permissions
#    - App Token (xapp-...) from Basic Information → App-Level Tokens (needs connections:write)
#    - Your User ID from your Slack profile → "..." → Copy member ID

# 3. Configure and run
npm run slack:setup   # Enter your credentials
npm run slack         # Start the bot

# 4. In another terminal, start a monitored Claude session
npm run claude
```

A new channel/thread is created for each session. Messages relay bidirectionally.

## Discord Commands

### Session Management
| Command | Description |
|---------|-------------|
| `/claude start` | Start a new Claude session (select directory) |
| `/claude stop` | Stop a running session |
| `/claude status` | Show all managed sessions |
| `/sessions` | List active sessions |

### In-Session Controls
| Command | Description |
|---------|-------------|
| `/interrupt` | Interrupt Claude (Escape) |
| `/background` | Send to background mode (Ctrl+B) |
| `/mode` | Toggle plan/execute mode (Shift+Tab) |
| `/compact` | Compact the conversation |
| `/model <name>` | Switch model (opus, sonnet, haiku) |
| `/panel` | Show control panel with buttons |
| `/yolo-sleep` | Toggle YOLO mode (auto-approve all) |

### Settings
| Command | Description |
|---------|-------------|
| `/claude add-dir <path>` | Add directory to whitelist |
| `/claude remove-dir` | Remove directory from whitelist |
| `/claude list-dirs` | List whitelisted directories |
| `/claude set-terminal` | Set terminal app (Terminal.app, iTerm2, or background) |

### Codex (OpenAI)
| Command | Description |
|---------|-------------|
| `/codex start` | Start a new Codex session (select directory) |
| `/codex stop` | Stop a running Codex session |
| `/codex status` | Show all Codex sessions |

### Other
| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |

## All Platform Commands

| Command | Slack | Discord | Telegram | Description |
|---------|:-----:|:-------:|:--------:|-------------|
| `/sessions` | ✓ | ✓ | ✓ | List active sessions |
| `/switch <name>` | - | - | ✓ | Switch session (Telegram only) |
| `/model <name>` | ✓ | ✓ | ✓ | Switch model |
| `/compact` | ✓ | ✓ | ✓ | Compact conversation |
| `/background` | ✓ | ✓ | ✓ | Background mode (Ctrl+B) |
| `/interrupt` | ✓ | ✓ | ✓ | Interrupt (Escape) |
| `/mode` | ✓ | ✓ | ✓ | Toggle mode (Shift+Tab) |

## Global Install

Install globally to use `sleep-code` command anywhere:

```bash
cd sleep-code
npm link
```

Now available anywhere:

```bash
sleep-code telegram setup   # Configure Telegram
sleep-code telegram         # Run Telegram bot
sleep-code discord setup    # Configure Discord
sleep-code discord          # Run Discord bot
sleep-code slack setup      # Configure Slack
sleep-code slack            # Run Slack bot
sleep-code hook setup       # Configure permission hook
sleep-code claude           # Start Claude session
sleep-code help             # Show help
```

## PM2 Background Execution

Use PM2 to run bots in background and auto-start on boot.

### Install PM2

```bash
npm install -g pm2
```

### Start Bots

```bash
cd /path/to/sleep-code

# Start specific bot
pm2 start ecosystem.config.cjs --only sleep-telegram
pm2 start ecosystem.config.cjs --only sleep-discord
pm2 start ecosystem.config.cjs --only sleep-slack

# Start all bots
pm2 start ecosystem.config.cjs
```

### Monitor & Manage

```bash
pm2 status                # List running processes
pm2 logs                  # View all logs
pm2 logs sleep-discord    # View specific bot logs
pm2 monit                 # Real-time monitoring dashboard
```

### Process Control

```bash
pm2 restart sleep-discord   # Restart specific bot
pm2 restart all             # Restart all bots
pm2 stop sleep-discord      # Stop specific bot
pm2 stop all                # Stop all bots
```

### Auto-Start on Boot

```bash
# Generate startup script (run once)
pm2 startup

# Save current process list
pm2 save
```

## Permission Hook Setup

The permission hook forwards Claude Code's permission prompts (file writes, shell commands, etc.) to your chat platform so you can approve or deny them remotely.

```bash
npm run hook:setup
# or
sleep-code hook setup
```

This adds a `PermissionRequest` hook to `~/.claude/settings.json` that connects Claude Code to the Sleep Code bot. Without this, permission prompts will only appear in the local terminal and the bot cannot forward them to chat.

The hook is configured with a 24-hour timeout, so you can respond to permission requests even if you come back much later.

## How It Works

1. `npm run discord/telegram/slack` starts a bot that listens for sessions
2. `npm run claude` spawns Claude in a PTY and connects to the bot via Unix socket
3. The bot watches Claude's JSONL files for messages and relays them to chat
4. Messages you send in chat are forwarded to the terminal
5. Permission requests are forwarded to chat for approval (Discord/Slack) via the hook

## Semantic Memory (Optional)

Sleep Code automatically remembers important conversations — decisions, preferences, task assignments, and more — using a local vector database. Memory is **optional** and requires [Ollama](https://ollama.com/) running locally. If Ollama is not available, the bot runs normally without memory features.

### Pipeline Overview

```
Message → Collect → Distill → Dedup → Store → Recall
                       ↓
              Supersede (update detection)
```

1. **Collect** — Messages are collected in real-time with a per-channel sliding context window (default 15 messages)
2. **Distill** — A local LLM (`qwen2.5:7b`) classifies each message: store or skip. Only decisions, facts, preferences, tasks, and feedback are stored — casual chat and agent status reports are filtered out
3. **Validate** — Substance validation rejects vague distilled text (e.g. "SnoopDuck 요청함") that lacks concrete content (dates, numbers, file paths, code tokens)
4. **Dedup** — Two-layer deduplication prevents redundant storage:
   - Exact text match (before embedding, saves cost)
   - Vector similarity ≥ 0.90 (catches paraphrases)
5. **Supersede** — If the distill detects a correction or update (time change, name fix, price revision), it automatically finds the old memory and marks it `superseded` instead of creating a duplicate. Uses multi-signal scoring: vector similarity, topic match, anchor term overlap, and kind compatibility
6. **Embed** — Stored memories are embedded via Ollama (`qwen3-embedding`) into 1024-dimensional vectors
7. **Store** — Vectors + metadata are saved in LanceDB (`~/.sleep-code/memory/lancedb`)
8. **Recall** — Hybrid search blends vector similarity with keyword overlap for better results. Short queries lean more on keyword matching; longer queries favor semantic similarity

### Quality Controls

| Feature | What it does |
|---------|-------------|
| **Substance validation** | Rejects vague meta-descriptions, requires concrete signals (dates, numbers, names) |
| **Speaker attribution** | Tracks who _made_ the decision, not who _reported_ it |
| **TopicKey injection** | Feeds existing topic tags into the distill prompt to prevent fragmentation |
| **CJK language guard** | Detects Chinese/Japanese output and retries in Korean/English |
| **Agent noise filter** | Skips agent observation messages (status updates, not decisions) |

### Memory Lifecycle

Memories go through these statuses:

```
open → in_progress → resolved
  ↓         ↓
snoozed   expired
  ↓
superseded (soft-delete: old info replaced by newer info)
```

**Superseded memories** are hidden from search by default but preserved for history. They can be viewed with `--include-superseded` and restored with `unsupersede`.

### Consolidation

Periodic cleanup that merges similar memories and removes noise:

1. **TopicKey merge** — Same topic + kind, within 7 days, cosine ≥ 0.85 → merge
2. **Vector merge** — Any two memories with cosine ≥ 0.93 → merge
3. **Cleanup** — Removes priority-0 observations

Run with `--dry-run` to preview, then without to apply.

### CLI Commands

```bash
sleep-code memory search <query> [--project <name>]          # Hybrid search (vector + keyword)
sleep-code memory store <text> [--project <name>] [--kind <kind>]  # Manual store
sleep-code memory delete <id>                                 # Delete by ID
sleep-code memory supersede <oldId> <newId>                   # Manually mark old as superseded
sleep-code memory unsupersede <id>                            # Undo supersede, restore to open
sleep-code memory stats <project>                             # Count memories
sleep-code memory consolidate [--project <name>] [--dry-run]  # Merge duplicates, clean noise
sleep-code memory retag [--project <name>] [--dry-run]        # Re-classify topicKeys via LLM
sleep-code memory graph [--project <name>] [--threshold 0.7]  # Open memory graph in browser
sleep-code memory distill-test                                # Test distill with sample messages
```

### MCP Memory Server

The memory store is exposed as an [MCP](https://modelcontextprotocol.io/) server over HTTP, making memories available to any Claude Code session.

**Transport:** HTTP (Streamable HTTP) at `http://127.0.0.1:24242/mcp`

```bash
npm run memory-server                                    # Direct
pm2 start ecosystem.config.cjs --only sleep-memory-mcp   # Background
```

**Claude Code auto-connects** via `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "sleep-code-memory": {
      "type": "http",
      "url": "http://127.0.0.1:24242/mcp"
    }
  }
}
```

To use in other projects, copy this `.mcp.json` or add the entry to that project's `.mcp.json`.

**MCP tools:**

| Tool | Description |
|------|-------------|
| `sc_memory_search` | Semantic search. Supports `query`, `project`, `limit`, `includeSuperseded`. |
| `sc_memory_list` | List memories for a project. Supports `includeSuperseded`. |
| `sc_memory_store` | Manually store a memory (text, project, kind, speaker, priority, topicKey). |

### Memory Explorer

A web UI for browsing and visualizing the memory graph:

```bash
cd explorer && npm run dev   # Opens at http://localhost:3000
```

### Disabling Memory

```bash
DISABLE_MEMORY=1 npm run discord          # Environment variable
# Or simply don't run Ollama — memory auto-disables gracefully
```

### Requirements

- [Ollama](https://ollama.com/) running locally with:
  - `qwen2.5:7b` — distill model (classifies and evaluates messages)
  - `qwen3-embedding` — embedding model (auto-pulled on first use)
- Memory data: `~/.sleep-code/memory/lancedb`
## Architecture

```
src/
├── cli/           # CLI entry point and commands
│   ├── index.ts   # Main CLI entry
│   ├── run.ts     # Session runner (PTY + JSONL watching)
│   └── {telegram,discord,slack}.ts  # Platform setup/run
├── memory/        # Semantic memory pipeline
│   ├── memory-service.ts       # LanceDB store (vector + metadata)
│   ├── memory-collector.ts     # Message ingestion from Discord
│   ├── distill-service.ts      # LLM classifier (store or skip)
│   ├── embedding-provider.ts   # Ollama embedding abstraction
│   ├── consolidation-service.ts # Memory dedup and cleanup
│   └── chat-provider.ts        # LLM chat abstraction
├── mcp/
│   └── memory-server.ts  # MCP server (HTTP transport)
├── discord/
│   ├── discord-app.ts      # Discord.js app and event handlers
│   ├── channel-manager.ts  # Thread/channel management
│   ├── process-manager.ts  # Session spawning and lifecycle
│   ├── settings-manager.ts # User settings (directories, terminal app)
│   └── codex/              # OpenAI Codex integration
│       ├── codex-session-manager.ts  # SDK session lifecycle
│       └── codex-handlers.ts         # Codex events → Discord messages
├── slack/
│   ├── slack-app.ts        # Slack Bolt app
│   └── session-manager.ts  # JSONL watching, shared across platforms
└── telegram/
    └── telegram-app.ts     # grammY app and event handlers
```

## Codex Integration (Discord)

Run OpenAI Codex sessions alongside Claude in the same Discord thread for multi-agent workflows.

### Setup

Set `OPENAI_API_KEY` in your `.env` file, or run `codex login` to authenticate via OAuth (`~/.codex/auth.json`). Codex is auto-detected on bot startup.

### Multi-Agent Threads

When both Claude and Codex are in the same thread, use prefixes to route messages:

| Prefix | Target | Example |
|--------|--------|---------|
| `c:` or `claude:` | Claude | `c: explain this code` |
| `x:` or `codex:` | Codex | `x: run the tests` |
| (none) | Last active agent | `fix the bug` |

Using `x:` in a Claude-only thread will auto-create a Codex session in the same directory.

See [docs/codex-integration-en.md](docs/codex-integration-en.md) for full details.

### Multi-Agent Protocol Skill

A Claude Code skill is included to quickly set up the multi-agent protocol on any project. Copy it to your skills directory:

```bash
mkdir -p ~/.claude/skills/setup-multi-agent
cp docs/skills/setup-multi-agent.md ~/.claude/skills/setup-multi-agent/SKILL.md
```

Then use `/setup-multi-agent` in Claude Code to add the collaboration protocol to your project's `CLAUDE.md` and `AGENTS.md`.

## Warning: YOLO Mode

> **Use YOLO mode at your own risk.**

YOLO mode (`/yolo-sleep` or the YOLO button) auto-approves **all** permission requests without confirmation. This means Claude can:

- Execute any shell commands
- Read, write, and delete files
- Make network requests
- Install packages

Only enable YOLO mode if you fully trust the task and understand the risks. **You are responsible for any actions taken while YOLO mode is enabled.**

## Known Issues

- **Missing assistant messages**: Claude Code occasionally fails to write assistant messages to its JSONL log file. When this happens, some responses may not appear in chat. This is a Claude Code bug, not a Sleep Code issue.

## Disclaimer

This project is not affiliated with Anthropic. Use at your own risk.

## Acknowledgments

This project was inspired by and initially based on [afk-code](https://github.com/clharman/afk-code) by @clharman. Thanks for the great foundation!

## License

MIT
