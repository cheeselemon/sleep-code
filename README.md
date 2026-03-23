# Sleep Code

[English](README.md) | [한국어](README.ko.md)

<p align="center">
  <img width="256" height="256" alt="Sleep Code" src="https://github.com/user-attachments/assets/2e82e717-c957-4be3-827c-f03e22cfaa07" />
</p>

<p align="center">
  <strong>Code from your bed.</strong> Monitor and control Claude Code sessions from Discord, Slack, or Telegram.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sleep-code"><img src="https://img.shields.io/npm/v/sleep-code" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node 18+">
</p>

## What is Sleep Code?

Sleep Code bridges Claude Code (and Codex) with your chat platform. Start a coding session, walk away, and keep working from your phone — approve permissions, send instructions, and read outputs in real time.

## Features

- **Bidirectional messaging** — chat ↔ Claude Code in real time
- **Permission handling** — approve/deny tool calls with Discord/Slack buttons
- **YOLO mode** — auto-approve all permissions (use with caution)
- **Session management** — start, stop, restore sessions from Discord
- **Claude Agent SDK** — run sessions without a terminal via SDK `query()`
- **Codex integration** — run OpenAI Codex alongside Claude in the same thread
- **Semantic memory** — auto-distill conversations → local vector DB, daily digest briefings
- **Multi-platform** — Discord (full features), Slack, Telegram

## Quick Start

```bash
git clone https://github.com/cheeselemon/sleep-code.git
cd sleep-code && npm install && npm run build

# Discord (recommended)
npm run discord:setup   # enter bot token + user ID
npm run discord         # start the bot

# Permission hook (enables remote approve/deny)
npm run hook:setup

# Start a monitored Claude session
npm run claude
```

For Telegram, Slack, and detailed setup → [Setup Guide](docs/setup.md)

## How It Works

```
You (Discord/Slack/Telegram)
  ↕ messages + permission buttons
Sleep Code Bot (Unix socket daemon)
  ↕ PTY or Claude Agent SDK
Claude Code / Codex
```

1. `npm run discord` starts a bot listening on a Unix socket
2. `npm run claude` spawns Claude in a PTY and connects to the bot
3. Messages relay bidirectionally: Claude ↔ Bot ↔ Chat
4. Permission requests forward to chat for interactive approval

## Documentation

| Document | Contents |
|----------|----------|
| **[Setup Guide](docs/setup.md)** | Installation, platform credentials, environment variables |
| **[Running Guide](docs/running.md)** | PM2 background mode, MCP server, Memory Explorer |
| **[Commands Reference](docs/commands.md)** | All slash commands, Memory CLI, platform comparison |
| **[Memory System](docs/memory.md)** | Distill pipeline, consolidation, daily digest, custom prompts |
| **[Architecture](docs/architecture.md)** | Component details, data flow, config files |
| **[SDK Sessions](docs/sdk-session.md)** | Claude Agent SDK session lifecycle and resume |
| **[Codex Integration](docs/codex-integration-en.md)** | Multi-agent setup and message routing |
| **[Troubleshooting](docs/troubleshooting.md)** | Known issues and debugging |

## Semantic Memory (Optional)

Conversations are auto-distilled into a local vector DB using Claude SDK + Ollama embeddings. Decisions, facts, and preferences are remembered; casual chat is filtered out.

- **Batch distill** — Claude SDK (haiku) classifies messages in batches
- **Daily digest** — scheduled briefings of open tasks and recent decisions
- **Consolidation** — auto-merges duplicates and cleans noise (24h cycle)
- **Custom prompts** — place `~/.sleep-code/digest-prompt.txt` to customize digest output

Requires [Ollama](https://ollama.com/) for embeddings. Without Ollama, the bot runs normally without memory.

→ Full details: **[Memory System](docs/memory.md)**

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Acknowledgments

- Inspired by and initially based on [afk-code](https://github.com/clharman/afk-code) by @clharman
- **Using OpenCode?** Check out [Disunday](https://github.com/code-xhyun/disunday) — same concept, different AI backend

## License

[MIT](LICENSE)
