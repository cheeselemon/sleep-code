# Running Guide

## Direct Execution

### Start a Bot

```bash
npm run discord         # Start the Discord bot
npm run telegram        # Start the Telegram bot
npm run slack           # Start the Slack bot
```

### Start a Claude Session

In another terminal:

```bash
npm run claude          # Start a monitored Claude Code session (PTY)
```

A new channel/thread is created for each session. Messages relay bidirectionally.

Alternatively, use the **Agent SDK** method from Discord — no separate terminal needed:

```
/claude start-sdk       # Start via Agent SDK (in-process)
```

See [SDK Session Guide](sdk-session.md) for details on the difference between PTY and SDK sessions.

### Global CLI

If you ran `npm link` (see [setup.md](setup.md)):

```bash
sleep-code discord          # Run Discord bot
sleep-code telegram         # Run Telegram bot
sleep-code slack            # Run Slack bot
sleep-code claude           # Start Claude session
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

## Session Restore

When a terminal closes (reboot, iTerm quit, window close, process kill), Claude Code sessions die. Sleep Code can restore them with conversation history intact.

### Automatic (on bot restart)

After PM2 restarts the bot, dead sessions are detected during startup reconciliation. Each dead session's Discord thread gets **Restore / Dismiss** buttons:

- **Restore** — Spawns a new Claude session with `--resume`, reconnects to the existing thread with full conversation history
- **Dismiss** — Cleans up the session and archives the thread
- Auto-dismissed after 1 hour if no action taken

### Manual (`/claude restore`)

In any thread with a dead session, run `/claude restore` to immediately restore it. This works even outside of the startup reconciliation window.

### Requirements

- The bot must be running (PM2 auto-restart handles this)
- The session's JSONL file must exist in `~/.claude/projects/*/` (not manually deleted)
- The Discord thread must still exist

## MCP Memory Server

The memory store is exposed as an [MCP](https://modelcontextprotocol.io/) server over HTTP, making memories available to any Claude Code session.

**Transport:** HTTP (Streamable HTTP) at `http://127.0.0.1:24242/mcp`

### Start the Server

```bash
# Direct
npm run memory-server

# PM2 background
pm2 start ecosystem.config.cjs --only sleep-memory-mcp
```

### Connect from Claude Code

Claude Code auto-connects via `.mcp.json` in the project root:

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

### MCP Tools

| Tool | Description |
|------|-------------|
| `sc_memory_search` | Semantic search. Supports `query`, `project`, `limit`, `includeSuperseded`. |
| `sc_memory_list` | List memories for a project. Supports `includeSuperseded`. |
| `sc_memory_store` | Manually store a memory (text, project, kind, speaker, priority, topicKey). |
| `sc_memory_update` | Update an existing memory's fields. |
| `sc_memory_supersede` | Mark a memory as superseded by another. |
| `sc_memory_delete` | Delete a memory by ID. |

## Memory Explorer

A web UI for browsing and visualizing the memory graph:

```bash
npm run explorer          # Opens at http://localhost:3333
# or
cd explorer && npm run dev
```

## Memory System (Discord)

When the Discord bot starts with memory enabled, it automatically:

- Creates a `#sleep-code-memory` channel
- Starts the **batch distill** pipeline (Claude SDK haiku, processes messages in batches)
- Starts the **consolidation scheduler** (merges duplicates every 24h)
- Starts the **daily digest** (briefings at scheduled times, default 10:00 + 16:00)

### Configuration

All memory settings live in `~/.sleep-code/memory-config.json` (hot-reloaded on file change):

```json
{
  "distill": { "enabled": true, "model": "haiku", "batchMaxMessages": 20, "batchIntervalMs": 1800000 },
  "consolidation": { "enabled": true, "intervalMs": 86400000 },
  "digest": { "enabled": true, "schedule": ["10:00", "16:00"], "timezone": "Asia/Seoul", "model": "sonnet" }
}
```

### Custom Digest Prompt

Place a template at `~/.sleep-code/digest-prompt.txt` to customize digest output.
Variables: `{{OPEN_TASKS}}`, `{{RECENT_DECISIONS}}`, `{{ACTIVE_TOPICS}}`, `{{TASK_COUNT}}`, `{{DECISION_COUNT}}`

### Discord Commands

| Command | Effect |
|---------|--------|
| `/memory opt-out` | Disable memory for this session |
| `/memory opt-out --global` | Pause entire memory system |
| `/memory opt-in` | Re-enable for this session |
| `/memory opt-in --global` | Resume entire memory system |
| `/memory status` | Show memory system status |
| `/settings` | Show current bot and memory configuration |

Full details: [Memory System](memory.md)

## Disabling Memory

```bash
DISABLE_MEMORY=1 npm run discord          # Environment variable
# Or don't run Ollama — embedding fails, memory auto-disables
```
