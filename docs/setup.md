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

Sleep Code is built around Discord. The Slack and Telegram clients still exist in the repo but are **experimental and feature-incomplete** — most newer features (SDK sessions, Codex, semantic memory threads, control panel, multi-agent routing, AskUserQuestion, etc.) ship Discord-only. Use them at your own risk.

### Discord (primary)

1. **Create a Discord app** at https://discord.com/developers/applications
   - Click "New Application" → enter a name
   - Go to **Bot** → "Reset Token" → copy the token (you will paste it later)
   - Toggle **"Message Content Intent"** ON (required — without this the bot cannot read your messages)
2. **Copy the Application ID** from the General Information page (top of the page, "Application ID" field)
3. **Invite the bot to your server** — pick one of the two methods below.

   **Method A — Direct invite URL (recommended)**

   Replace `YOUR_CLIENT_ID` with the Application ID from step 2, then paste the URL into your browser:

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2252126231308304&scope=bot%20applications.commands
   ```

   Pick the target server, click Authorize. Done. The permission integer is baked into the URL, so you don't have to assemble it yourself.

   **Method B — OAuth2 URL Generator (manual checklist)**

   If you'd rather see exactly which permissions are granted, go to **OAuth2 → URL Generator** in the developer portal and check these boxes:

   | Permission | Section |
   |------------|---------|
   | View Channels | General Permissions |
   | Manage Channels | General Permissions |
   | Send Messages | Text Permissions |
   | Send Messages in Threads | Text Permissions |
   | Create Public Threads | Text Permissions |
   | Manage Threads | Text Permissions |
   | Manage Messages | Text Permissions |
   | Embed Links | Text Permissions |
   | Attach Files | Text Permissions |
   | Read Message History | Text Permissions |
   | Use Application Commands | Text Permissions |

   Under "Scopes" check **`bot`** and **`applications.commands`**. The "Generated URL" textbox at the bottom should contain `permissions=2252126231308304` — if it doesn't, a checkbox is missing or extra. Open the URL to invite the bot.
4. **Get your User ID** — in Discord, go to Settings → Advanced → enable **Developer Mode**, then right-click your username and choose "Copy User ID".
5. **Run setup** and paste the bot token + your User ID when prompted:

```bash
npm run discord:setup
```

### Telegram (experimental)

> ⚠️ Feature-incomplete: no permission buttons (Telegram lacks Discord-style interactive components in the same way), no Codex integration, no SDK session UI, no control panel. Treat as a basic relay.

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

### Slack (experimental)

> ⚠️ Feature-incomplete: button/modal flows are partially implemented, no Codex integration, no SDK session UI, no control panel. Treat as a basic relay.

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
