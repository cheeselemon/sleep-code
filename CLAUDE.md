# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Sleep Code

Monitor and interact with Claude Code sessions from Slack, Discord, or Telegram. Respond from your phone while away.

## Build & Run

```bash
npm run build           # Build with tsup (required before running)
npm run telegram:setup  # Configure Telegram credentials
npm run telegram        # Start the Telegram bot
npm run discord:setup   # Configure Discord credentials
npm run discord         # Start the Discord bot
npm run slack:setup     # Configure Slack credentials
npm run slack           # Start the Slack bot
npm run claude          # Start a monitored Claude Code session
```

### PM2 Background Execution

```bash
pm2 start ecosystem.config.cjs --only sleep-telegram  # Or sleep-discord, sleep-slack
pm2 restart sleep-telegram
pm2 logs sleep-telegram
```

## Architecture

```
src/
├── cli/           # CLI entry point and commands
│   ├── index.ts   # Main CLI entry
│   ├── run.ts     # Session runner (PTY + JSONL watching)
│   ├── hook.ts    # Claude Code permission hook handler
│   └── {telegram,discord,slack}.ts  # Platform-specific setup/run
├── slack/
│   ├── slack-app.ts        # Slack Bolt app and event handlers
│   └── session-manager.ts  # JSONL watching, session tracking (shared by all platforms)
├── discord/
│   ├── discord-app.ts      # Discord.js app and event handlers
│   └── channel-manager.ts  # Thread/channel management
└── telegram/
    └── telegram-app.ts     # grammY app and event handlers
```

### How It Works

1. `npm run {platform}` starts a bot with a Unix socket daemon
2. `npm run claude` spawns Claude in a PTY and connects via socket
3. Session manager watches Claude's `~/.claude/projects/*/session.jsonl` files
4. Messages relay bidirectionally: JSONL → Bot → Chat, Chat → Bot → PTY
5. Permission requests are handled via `hook.ts` (forwards to daemon for Discord/Slack button interactions)

### Key Patterns

- **SessionManager** (`src/slack/session-manager.ts`): Shared across all platforms. Watches JSONL files, emits events for messages, tool calls, permissions
- **Platform Apps**: Each creates their own UI (threads/channels/chats) and handles platform-specific interactions
- **Permission Hook**: `src/cli/hook.ts` connects to daemon socket, forwards Claude Code's permission prompts to chat platforms for interactive approval
