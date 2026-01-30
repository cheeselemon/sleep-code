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

## Global Install

전역 명령어로 설치하면 어디서든 `sleep-code` 명령어를 사용할 수 있습니다.

```bash
cd sleep-code
npm link
```

이제 어디서든 사용 가능:

```bash
sleep-code telegram setup   # Telegram 설정
sleep-code telegram         # Telegram 봇 실행
sleep-code discord setup    # Discord 설정
sleep-code discord          # Discord 봇 실행
sleep-code slack setup      # Slack 설정
sleep-code slack            # Slack 봇 실행
sleep-code claude           # Claude 세션 시작
sleep-code help             # 도움말
```

## Commands (npm run)

프로젝트 폴더 내에서 npm으로 실행할 수도 있습니다:

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

PM2를 사용하면 봇을 백그라운드에서 실행하고, 시스템 부팅 시 자동으로 시작할 수 있습니다.

### 1. PM2 설치

```bash
npm install -g pm2
```

### 2. 봇 실행

```bash
cd /path/to/sleep-code

# Telegram 봇만 실행
pm2 start ecosystem.config.cjs --only sleep-telegram

# Discord 봇만 실행
pm2 start ecosystem.config.cjs --only sleep-discord

# Slack 봇만 실행
pm2 start ecosystem.config.cjs --only sleep-slack

# 모든 봇 동시 실행
pm2 start ecosystem.config.cjs
```

### 3. 상태 확인 및 관리

```bash
pm2 status                # 실행 중인 프로세스 목록
pm2 logs                  # 모든 로그 보기
pm2 logs sleep-telegram   # 특정 봇 로그만 보기
pm2 monit                 # 실시간 모니터링 대시보드
```

### 4. 프로세스 제어

```bash
pm2 restart sleep-telegram  # 특정 봇 재시작
pm2 restart all             # 모든 봇 재시작
pm2 stop sleep-telegram     # 특정 봇 중지
pm2 stop all                # 모든 봇 중지
pm2 delete sleep-telegram   # 특정 봇 삭제
pm2 delete all              # 모든 봇 삭제
```

### 5. 시스템 부팅 시 자동 시작

```bash
# 시작 스크립트 생성 (한 번만 실행)
pm2 startup

# 현재 실행 중인 프로세스 저장
pm2 save
```

이후 컴퓨터를 재부팅해도 봇이 자동으로 시작됩니다.

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
