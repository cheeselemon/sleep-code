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
- **Permission handling** - Approve or deny tool permissions from chat (Discord/Slack)
- **YOLO mode** - Auto-approve all permission requests
- **Session management** - Start, stop, and monitor sessions from Discord
- **Session restore** - Recover dead sessions with conversation history (`/claude restore`)
- **Codex integration** - Run OpenAI Codex sessions alongside Claude in the same thread
- **Terminal app support** - Open sessions in Terminal.app or iTerm2 (macOS)
- **Multi-platform** - Works with Telegram, Discord, and Slack
- **Semantic memory** - Auto-distills conversations into a local vector DB (LanceDB + Ollama), searchable via MCP
- **Memory Explorer** - Web UI for browsing and visualizing the memory graph

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

For Telegram and Slack setup, see the [Setup Guide](docs/setup.md).

## How It Works

1. `npm run discord/telegram/slack` starts a bot that listens for sessions
2. `npm run claude` spawns Claude in a PTY and connects to the bot via Unix socket
3. The bot watches Claude's JSONL files for messages and relays them to chat
4. Messages you send in chat are forwarded to the terminal
5. Permission requests are forwarded to chat for approval (Discord/Slack) via the hook

## Documentation

| Document | Contents |
|----------|----------|
| [Setup Guide](docs/setup.md) | Installation, platform setup, environment variables, config files |
| [Running Guide](docs/running.md) | Direct execution, PM2, MCP server, Memory Explorer |
| [Commands Reference](docs/commands.md) | Discord/Slack/Telegram commands, Memory CLI |
| [Codex Integration](docs/codex-integration-en.md) | Multi-agent setup and message routing |

## Semantic Memory (Optional)

Automatically remembers important conversations using a local vector database. Requires [Ollama](https://ollama.com/) running locally. If Ollama is not available, the bot runs normally without memory features.

```
Message → Collect → Distill → Dedup → Store → Recall
```

- **Distill** — Local LLM classifies messages: store decisions/facts/preferences, skip casual chat
- **Dedup** — Exact text match + vector similarity prevents redundant storage
- **Supersede** — Corrections automatically replace old memories
- **Hybrid search** — Blends vector similarity with keyword overlap

See [Running Guide](docs/running.md) for MCP server setup and [Commands Reference](docs/commands.md) for Memory CLI.

## Architecture

```
src/
├── cli/           # CLI entry point and commands
├── memory/        # Semantic memory pipeline (LanceDB, Ollama)
├── mcp/           # MCP memory server (HTTP transport)
├── discord/       # Discord.js app, session/channel management, Codex integration
├── slack/         # Slack Bolt app, session manager (shared across platforms)
└── telegram/      # grammY app

explorer/          # Memory Explorer web app (Next.js 16)
```

## Warning: YOLO Mode

> **Use YOLO mode at your own risk.**

YOLO mode auto-approves **all** permission requests without confirmation. This means Claude can execute any shell commands, read/write/delete files, make network requests, and install packages. Only enable if you fully trust the task and understand the risks.

## Known Issues

- **Missing assistant messages**: Claude Code occasionally fails to write assistant messages to its JSONL log file. When this happens, some responses may not appear in chat. This is a Claude Code bug, not a Sleep Code issue.

## Disclaimer

This project is not affiliated with Anthropic. Use at your own risk.

## Acknowledgments

This project was inspired by and initially based on [afk-code](https://github.com/clharman/afk-code) by @clharman. Thanks for the great foundation!

## License

MIT
