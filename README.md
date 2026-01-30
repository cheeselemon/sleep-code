# Sleep Code

Monitor and interact with Claude Code sessions from Slack, Discord, or Telegram. Respond from your phone while away.

<img src="https://github.com/user-attachments/assets/83083b63-9ca2-4ef0-b83d-fcc51bd2fff9" alt="Sleep Code iPhone Slack screenshot" width="400">

## Client Comparison

Telegram and Discord are recommended.

| | Telegram | Discord | Slack |
|---|---|---|---|
| Siri integration | Receive & Send | Receive only | Receive only |
| Multi-session support | One at a time (switchable) | Yes | Yes |
| Permissions required | Personal | Personal | Admin |

## Quick Start (Telegram)

```bash
# 1. Create a bot with @BotFather on Telegram
#    - Send /newbot and follow the prompts
#    - Copy the bot token

# 2. Get your Chat ID
#    - Message your bot, then visit:
#    - https://api.telegram.org/bot<TOKEN>/getUpdates
#    - Find "chat":{"id":YOUR_CHAT_ID}

# 3. Clone and setup
git clone https://github.com/cheeselemon/sleep-code.git
cd sleep-code && npm install && npm run build

# 4. Configure and run
npm run telegram:setup   # Enter your credentials
npm run telegram         # Start the bot

# 5. In another terminal, start a monitored Claude session
npm run claude
```

## Quick Start (Discord)

```bash
# 1. Create a Discord app at https://discord.com/developers/applications
#    - Go to Bot → Reset Token → copy it
#    - Enable "Message Content Intent"
#    - Go to OAuth2 → URL Generator → select "bot" scope
#    - Select permissions: Send Messages, Manage Channels, Read Message History
#    - Open the generated URL to invite the bot

# 2. Get your User ID (enable Developer Mode, right-click your name → Copy User ID)

# 3. Configure and run
npm run discord:setup   # Enter your credentials
npm run discord         # Start the bot

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

A new channel is created for each session. Messages relay bidirectionally.

## Commands

```bash
npm run telegram:setup   # Configure Telegram credentials
npm run telegram         # Run the Telegram bot
npm run discord:setup    # Configure Discord credentials
npm run discord          # Run the Discord bot
npm run slack:setup      # Configure Slack credentials
npm run slack            # Run the Slack bot
npm run claude           # Start a monitored session
```

### Slash Commands

| Command | Slack | Discord | Telegram | Description |
|---------|:-----:|:-------:|:--------:|-------------|
| `/sessions` | ✓ | ✓ | ✓ | List active sessions |
| `/switch <name>` | - | - | ✓ | Switch session (Telegram only) |
| `/model <name>` | ✓ | ✓ | ✓ | Switch model (opus, sonnet, haiku) |
| `/compact` | ✓ | ✓ | ✓ | Compact the conversation |
| `/background` | ✓ | ✓ | ✓ | Send Ctrl+B (background mode) |
| `/interrupt` | ✓ | ✓ | ✓ | Send Escape (interrupt) |
| `/mode` | ✓ | ✓ | ✓ | Toggle mode (Shift+Tab) |

## PM2 Background Execution

```bash
# Install pm2 globally
npm install -g pm2

# Start individual bot
pm2 start ecosystem.config.cjs --only sleep-telegram

# Start all bots
pm2 start ecosystem.config.cjs

# Manage
pm2 status              # Check status
pm2 logs sleep-telegram # View logs
pm2 restart all         # Restart all
pm2 stop all            # Stop all

# Auto-start on system boot
pm2 startup && pm2 save
```

## How It Works

1. `npm run telegram/discord/slack` starts a bot that listens for sessions
2. `npm run claude` spawns Claude in a PTY and connects to the bot via Unix socket
3. The bot watches Claude's JSONL files for messages and relays them to chat
4. Messages you send in chat are forwarded to the terminal

## Limitations

- Does not support plan mode or responding to Claude Code's form-based questions (AskUserQuestion)
- Does not send tool calls or results

## Disclaimer

This project is not affiliated with Anthropic. Use at your own risk.

## License

MIT
