# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Sleep Code

**Code from your bed.** Monitor and control Claude Code sessions from Slack, Discord, or Telegram.

## Features

- Real-time bidirectional messaging with Claude Code
- Permission request handling with interactive buttons (Discord/Slack)
- YOLO mode for auto-approving all permissions
- Session management from Discord (start/stop sessions remotely)
- Terminal app support (Terminal.app, iTerm2) on macOS
- Multi-platform: Telegram, Discord, Slack

## Build & Run

```bash
npm run build           # Build with tsup (required before running)
npm run discord:setup   # Configure Discord credentials
npm run discord         # Start the Discord bot
npm run telegram:setup  # Configure Telegram credentials
npm run telegram        # Start the Telegram bot
npm run slack:setup     # Configure Slack credentials
npm run slack           # Start the Slack bot
npm run claude          # Start a monitored Claude Code session
```

### PM2 Background Execution

```bash
pm2 start ecosystem.config.cjs --only sleep-discord  # Or sleep-telegram, sleep-slack
pm2 restart sleep-discord
pm2 logs sleep-discord
```

## Architecture

```
src/
├── cli/                    # CLI entry point and commands
│   ├── index.ts            # Main CLI entry (commander.js)
│   ├── run.ts              # Session runner (PTY + Unix socket connection)
│   ├── hook.ts             # Claude Code permission hook handler
│   └── {telegram,discord,slack}.ts  # Platform-specific setup/run
├── discord/
│   ├── discord-app.ts      # Discord.js app, slash commands, button handlers
│   ├── channel-manager.ts  # Thread/channel management, session mapping
│   ├── process-manager.ts  # Session spawning, lifecycle, terminal window tracking
│   └── settings-manager.ts # User settings (allowed directories, terminal app)
├── slack/
│   ├── slack-app.ts        # Slack Bolt app and event handlers
│   └── session-manager.ts  # JSONL watching, session tracking (shared by all platforms)
└── telegram/
    └── telegram-app.ts     # grammY app and event handlers
```

## How It Works

1. `npm run {platform}` starts a bot with a Unix socket daemon at `/tmp/sleep-code-daemon.sock`
2. `npm run claude` spawns Claude in a PTY and connects via socket
3. SessionManager watches Claude's JSONL files (`~/.claude/projects/*/{sessionId}.jsonl`)
4. Messages relay bidirectionally: JSONL → Bot → Chat, Chat → Bot → PTY
5. Permission requests forward to chat for interactive approval (buttons)

## Key Components

### SessionManager (`src/slack/session-manager.ts`)
Shared across all platforms. Handles:
- JSONL file watching with chokidar
- Message deduplication
- Tool call/result extraction
- Permission request forwarding
- Session lifecycle events

### ProcessManager (`src/discord/process-manager.ts`)
Discord-only. Handles:
- Spawning Claude sessions (background or terminal app)
- Process lifecycle (start, stop, health checks)
- Terminal window ID tracking for proper cleanup
- Registry persistence (`~/.sleep-code/process-registry.json`)

### ChannelManager (`src/discord/channel-manager.ts`)
Discord-only. Handles:
- Creating threads for each session
- Session-to-thread mapping
- Thread archival on session end

## Discord Slash Commands

- `/help` - Show all commands (embed card)
- `/claude start|stop|status` - Session management
- `/claude add-dir|remove-dir|list-dirs|set-terminal` - Settings
- `/interrupt`, `/background`, `/mode`, `/compact`, `/model` - In-session controls
- `/panel` - Show control buttons (Interrupt, YOLO toggle)
- `/yolo-sleep` - Toggle YOLO mode (auto-approve all permissions)

## Multi-Agent Communication Protocol

### 화자 식별

모든 메시지에는 발신자 프리픽스가 붙습니다:
- **사람**: `{Discord displayName}: 메시지` (예: `cheeselemon: 진행해줘`)
- **Claude → Codex**: `Claude: 메시지`
- **Codex → Claude**: `Codex: 메시지`

### 승인 규칙

- **작업 승인/진행 지시는 사람(human) 메시지만 유효**
- `Claude:` 또는 `Codex:` 프리픽스 메시지의 "진행해", "동의" 등은 승인이 아닌 **의견**
- 사람 승인 필요 시 반드시 사람 프리픽스 메시지 확인 후 진행

### Routing

- `사람 → Claude`: `{displayName}: 내용`
- `사람 → Codex`: `@codex`로 시작
- `Claude → Codex`: `@codex`를 메시지에 포함
- `Codex → Claude`: `@claude`를 메시지에 포함

**`@` 멘션 규칙:**
- `@codex`, `@claude`는 **메시지 전달(라우팅) 용도로만** 사용
- 상대를 지칭할 때는 `@` 없이 "codex", "claude"로 표기

### File-Based Context Sharing

에이전트 간 긴 컨텍스트(3줄+)는 **반드시 파일로 공유**. Discord 라우팅 한계 때문.
- 파일 위치: `docs/plans/<feature>-{plan,report,discussion}.md`
- 상대에게는 **파일 경로 + 요약 1~2줄**만 전달
- Codex가 read-only일 경우 메시지로 내용 전달 → Claude가 파일에 반영

## Code Style

- TypeScript with ES modules
- Async/await for all async operations
- Pino for structured logging (`src/utils/logger.ts`)
- Error handling: catch and log, don't crash the bot
