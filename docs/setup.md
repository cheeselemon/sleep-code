# Setup Guide

## Prerequisites

- **Node.js** 18+
- **npm** or compatible package manager
- [Ollama](https://ollama.com/) (optional, for semantic memory embeddings)
  - `qwen3-embedding:4b` — embedding model (auto-pulled on first use)
  - Distill classification uses Claude Agent SDK (haiku), not Ollama

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
   - Select permissions: Send Messages, Manage Messages, Manage Channels, Manage Threads, Create Public Threads, Send Messages in Threads, Read Message History, Attach Files
   - Permission integer should be `2252126231308304`
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

> **Note:** GPT-5.5 and `xhigh` reasoning effort require Codex CLI ≥ 0.125. The bundled `@openai/codex-sdk` ships a compatible CLI; if you also installed the standalone Codex CLI globally, run `npm i -g @openai/codex@latest` to upgrade.

`/codex start` lets you pick the model and reasoning effort per session (gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex / 5.2 with effort levels minimal → xhigh). `/codex intelligence` switches the effort mid-session without losing context.

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
| `~/.sleep-code/discord.env` | Discord bot token + user ID (also `OPENROUTER_API_KEY` / `DEEPINFRA_API_KEY` for `/chat`) |
| `~/.sleep-code/slack.env` | Slack tokens |
| `~/.sleep-code/settings.json` | Allowed dirs, terminal app, maxConcurrentSessions |
| `~/.sleep-code/process-registry.json` | ProcessManager session registry |
| `~/.sleep-code/session-mappings.json` | Claude PTY session → Discord thread mappings |
| `~/.sleep-code/sdk-session-mappings.json` | Claude SDK session → Discord thread mappings (incl. `sdkSessionId`, `sdkModel`) |
| `~/.sleep-code/codex-session-mappings.json` | Codex session → Discord thread mappings (incl. `codexThreadId`, `codexModel`, `codexModelReasoningEffort`) |
| `~/.sleep-code/agent-session-mappings.json` | Generic agent (`/chat`) session → thread mappings |
| `~/.sleep-code/agent-sessions/` | Per-session conversation history JSONL for `/chat` agents |
| `~/.sleep-code/logs/` | PM2-bound rotating log files (pino) |
| `~/.sleep-code/memory-config.json` | Memory system config (distill, consolidation, digest) — hot-reloaded |
| `~/.sleep-code/digest-prompt.txt` | Custom daily digest prompt template (optional) |
| `~/.sleep-code/memory/lancedb/` | LanceDB vector store |
