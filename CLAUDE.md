## Project: Sleep Code

Interact with Claude Code sessions from Slack, Discord, and Telegram.

### Architecture
- **CLI**: `src/cli/` - Commands for `npm run telegram`, `npm run discord`, `npm run slack`, `npm run claude`
- **Slack**: `src/slack/` - Slack bot integration
- **Discord**: `src/discord/` - Discord bot integration
- **Telegram**: `src/telegram/` - Telegram bot integration via grammY

### Running
```bash
# Telegram setup (first time)
npm run telegram:setup

# Start the Telegram bot
npm run telegram

# Discord setup (first time)
npm run discord:setup

# Start the Discord bot
npm run discord

# Slack setup (first time)
npm run slack:setup

# Start the Slack bot
npm run slack

# Start a monitored Claude Code session (in another terminal)
npm run claude
```

### Key Files
- `src/cli/index.ts` - CLI entry point
- `src/cli/run.ts` - Session runner (PTY + JSONL watching)
- `src/cli/slack.ts` - Slack setup and run commands
- `src/cli/discord.ts` - Discord setup and run commands
- `src/cli/telegram.ts` - Telegram setup and run commands
- `src/slack/session-manager.ts` - JSONL watching and session tracking (shared)
- `src/slack/slack-app.ts` - Slack Bolt app and event handlers
- `src/discord/discord-app.ts` - Discord.js app and event handlers
- `src/telegram/telegram-app.ts` - Telegram grammY app and event handlers
- `slack-manifest.json` - Slack app manifest for easy setup
- `ecosystem.config.cjs` - PM2 configuration for background execution
