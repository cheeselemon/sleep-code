# Setup Guide

## Prerequisites

- **Node.js** 18+
- **npm** or compatible package manager
- [Ollama](https://ollama.com/) (optional, for semantic memory)
  - `qwen2.5:7b` — distill model
  - `qwen3-embedding` — embedding model (auto-pulled on first use)

## Install

```bash
git clone https://github.com/cheeselemon/sleep-code.git
cd sleep-code
npm install
npm run build
```

## Platform Setup

### Discord

1. Create a Discord app at https://discord.com/developers/applications
   - Go to Bot → Reset Token → copy it
   - Enable "Message Content Intent"
   - Go to OAuth2 → URL Generator → select "bot" scope
   - Select permissions: Send Messages, Manage Channels, Read Message History
   - Open the generated URL to invite the bot
2. Get your User ID (enable Developer Mode, right-click your name → Copy User ID)
3. Run setup:

```bash
npm run discord:setup   # Enter your credentials
```

### Telegram

1. Create a bot with @BotFather on Telegram
   - Send /newbot and follow the prompts
   - Copy the bot token
2. Get your Chat ID
   - Message your bot, then visit: `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Find `"chat":{"id":YOUR_CHAT_ID}`
3. Run setup:

```bash
npm run telegram:setup   # Enter your credentials
```

### Slack

1. Create a Slack app at https://api.slack.com/apps
   - Click "Create New App" → "From manifest" → paste `slack-manifest.json`
2. Install to your workspace and get credentials:
   - Bot Token (`xoxb-...`) from OAuth & Permissions
   - App Token (`xapp-...`) from Basic Information → App-Level Tokens (needs `connections:write`)
   - Your User ID from your Slack profile → "..." → Copy member ID
3. Run setup:

```bash
npm run slack:setup   # Enter your credentials
```

## Permission Hook

The permission hook forwards Claude Code's permission prompts to your chat platform so you can approve or deny them remotely.

```bash
npm run hook:setup
# or
sleep-code hook setup
```

This adds a `PermissionRequest` hook to `~/.claude/settings.json`. Without this, permission prompts will only appear in the local terminal.

The hook is configured with a 24-hour timeout.

## Global Install

Install globally to use `sleep-code` command anywhere:

```bash
cd sleep-code
npm link
```

Now available anywhere:

```bash
sleep-code telegram setup   # Configure Telegram
sleep-code discord setup    # Configure Discord
sleep-code slack setup      # Configure Slack
sleep-code hook setup       # Configure permission hook
sleep-code help             # Show help
```

## Codex Integration (Discord)

Set `OPENAI_API_KEY` in your `.env` file, or run `codex login` to authenticate via OAuth (`~/.codex/auth.json`). Codex is auto-detected on bot startup.

See [codex-integration-en.md](codex-integration-en.md) for full details.

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

## Config & Data Files

| Path | Purpose |
|------|---------|
| `~/.sleep-code/discord.env` | Discord bot token + user ID |
| `~/.sleep-code/slack.env` | Slack tokens |
| `~/.sleep-code/settings.json` | Allowed dirs, terminal app, maxConcurrentSessions |
| `~/.sleep-code/process-registry.json` | ProcessManager session registry |
| `~/.sleep-code/session-mappings.json` | Claude session → Discord thread mappings |
| `~/.sleep-code/codex-session-mappings.json` | Codex session → Discord thread mappings |
| `~/.sleep-code/memory/lancedb/` | LanceDB vector store |
