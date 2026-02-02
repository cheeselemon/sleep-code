# Sleep Code

[English](README.md) | [한국어](README.ko.md)

**Code from your bed.** Monitor and control Claude Code sessions from Slack, Discord, or Telegram.

<img width="1024" height="1024" alt="Sleep Code Logo" src="https://github.com/user-attachments/assets/2e82e717-c957-4be3-827c-f03e22cfaa07" />

## Features

- **Real-time messaging** - Send and receive messages to/from Claude Code
- **Permission handling** - Approve or deny tool permissions from chat (Discord)
- **YOLO mode** - Auto-approve all permission requests
- **Session management** - Start, stop, and monitor sessions from Discord
- **Terminal app support** - Open sessions in Terminal.app or iTerm2 (macOS)
- **Multi-platform** - Works with Telegram, Discord, and Slack

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

# 5. In another terminal, start a monitored Claude session
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

## How It Works

1. `npm run discord/telegram/slack` starts a bot that listens for sessions
2. `npm run claude` spawns Claude in a PTY and connects to the bot via Unix socket
3. The bot watches Claude's JSONL files for messages and relays them to chat
4. Messages you send in chat are forwarded to the terminal
5. Permission requests are forwarded to chat for approval (Discord/Slack)

## Architecture

```
src/
├── cli/           # CLI entry point and commands
│   ├── index.ts   # Main CLI entry
│   ├── run.ts     # Session runner (PTY + JSONL watching)
│   └── {telegram,discord,slack}.ts  # Platform setup/run
├── discord/
│   ├── discord-app.ts      # Discord.js app and event handlers
│   ├── channel-manager.ts  # Thread/channel management
│   ├── process-manager.ts  # Session spawning and lifecycle
│   └── settings-manager.ts # User settings (directories, terminal app)
├── slack/
│   ├── slack-app.ts        # Slack Bolt app
│   └── session-manager.ts  # JSONL watching, shared across platforms
└── telegram/
    └── telegram-app.ts     # grammY app and event handlers
```

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
