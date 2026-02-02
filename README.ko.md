# Sleep Code

[English](README.md) | [한국어](README.ko.md)

**누워서 코딩하세요.** Slack, Discord, Telegram에서 Claude Code 세션을 모니터링하고 제어하세요.

<img width="1024" height="1024" alt="Sleep Code Logo" src="https://github.com/user-attachments/assets/2e82e717-c957-4be3-827c-f03e22cfaa07" />

## 주요 기능

- **실시간 메시징** - Claude Code와 메시지 송수신
- **권한 처리** - 채팅에서 도구 권한 승인/거부 (Discord)
- **YOLO 모드** - 모든 권한 요청 자동 승인
- **세션 관리** - Discord에서 세션 시작, 중지, 모니터링
- **터미널 앱 지원** - Terminal.app 또는 iTerm2에서 세션 열기 (macOS)
- **멀티 플랫폼** - Telegram, Discord, Slack 지원

## 플랫폼 비교

| | Telegram | Discord | Slack |
|---|---|---|---|
| Siri 연동 | 수신 & 발신 | 수신만 | 수신만 |
| 멀티 세션 지원 | 하나씩 (전환 가능) | 예 | 예 |
| 권한 처리 | - | 예 (버튼) | 예 (버튼) |
| 세션 관리 | - | 예 (채팅에서 시작/중지) | - |
| 필요 권한 | 개인 | 개인 | 관리자 |

**추천:** 전체 기능은 Discord, Siri 연동은 Telegram

## 빠른 시작 (Discord)

```bash
# 1. https://discord.com/developers/applications 에서 Discord 앱 생성
#    - Bot → Reset Token → 복사
#    - "Message Content Intent" 활성화
#    - OAuth2 → URL Generator → "bot" 스코프 선택
#    - 권한 선택: Send Messages, Manage Channels, Read Message History
#    - 생성된 URL로 봇 초대

# 2. 사용자 ID 가져오기 (개발자 모드 활성화, 이름 우클릭 → Copy User ID)

# 3. 클론 및 설정
git clone https://github.com/cheeselemon/sleep-code.git
cd sleep-code && npm install && npm run build

# 4. 설정 및 실행
npm run discord:setup   # 인증 정보 입력
npm run discord         # 봇 시작

# 5. 다른 터미널에서 모니터링되는 Claude 세션 시작
npm run claude
```

## 빠른 시작 (Telegram)

```bash
# 1. Telegram에서 @BotFather로 봇 생성
#    - /newbot 전송 후 안내에 따라 진행
#    - 봇 토큰 복사

# 2. Chat ID 가져오기
#    - 봇에 메시지 전송 후 방문:
#    - https://api.telegram.org/bot<TOKEN>/getUpdates
#    - "chat":{"id":YOUR_CHAT_ID} 찾기

# 3. 설정 및 실행
npm run telegram:setup   # 인증 정보 입력
npm run telegram         # 봇 시작

# 4. 다른 터미널에서 모니터링되는 Claude 세션 시작
npm run claude
```

## 빠른 시작 (Slack)

```bash
# 1. https://api.slack.com/apps 에서 Slack 앱 생성
#    "Create New App" → "From manifest" → slack-manifest.json 붙여넣기

# 2. 워크스페이스에 설치하고 인증 정보 가져오기:
#    - Bot Token (xoxb-...) - OAuth & Permissions에서
#    - App Token (xapp-...) - Basic Information → App-Level Tokens (connections:write 필요)
#    - User ID - Slack 프로필 → "..." → Copy member ID

# 3. 설정 및 실행
npm run slack:setup   # 인증 정보 입력
npm run slack         # 봇 시작

# 4. 다른 터미널에서 모니터링되는 Claude 세션 시작
npm run claude
```

각 세션마다 새 채널/스레드가 생성됩니다. 메시지는 양방향으로 전달됩니다.

## Discord 명령어

### 세션 관리
| 명령어 | 설명 |
|---------|-------------|
| `/claude start` | 새 Claude 세션 시작 (디렉토리 선택) |
| `/claude stop` | 실행 중인 세션 중지 |
| `/claude status` | 관리 중인 모든 세션 표시 |
| `/sessions` | 활성 세션 목록 |

### 세션 내 컨트롤
| 명령어 | 설명 |
|---------|-------------|
| `/interrupt` | Claude 중단 (Escape) |
| `/background` | 백그라운드 모드로 전환 (Ctrl+B) |
| `/mode` | 계획/실행 모드 전환 (Shift+Tab) |
| `/compact` | 대화 압축 |
| `/model <name>` | 모델 전환 (opus, sonnet, haiku) |
| `/panel` | 버튼이 있는 컨트롤 패널 표시 |
| `/yolo-sleep` | YOLO 모드 토글 (모든 권한 자동 승인) |

### 설정
| 명령어 | 설명 |
|---------|-------------|
| `/claude add-dir <path>` | 화이트리스트에 디렉토리 추가 |
| `/claude remove-dir` | 화이트리스트에서 디렉토리 제거 |
| `/claude list-dirs` | 화이트리스트 디렉토리 목록 |
| `/claude set-terminal` | 터미널 앱 설정 (Terminal.app, iTerm2, 백그라운드) |

### 기타
| 명령어 | 설명 |
|---------|-------------|
| `/help` | 사용 가능한 모든 명령어 표시 |

## 전체 플랫폼 명령어

| 명령어 | Slack | Discord | Telegram | 설명 |
|---------|:-----:|:-------:|:--------:|-------------|
| `/sessions` | ✓ | ✓ | ✓ | 활성 세션 목록 |
| `/switch <name>` | - | - | ✓ | 세션 전환 (Telegram 전용) |
| `/model <name>` | ✓ | ✓ | ✓ | 모델 전환 |
| `/compact` | ✓ | ✓ | ✓ | 대화 압축 |
| `/background` | ✓ | ✓ | ✓ | 백그라운드 모드 (Ctrl+B) |
| `/interrupt` | ✓ | ✓ | ✓ | 중단 (Escape) |
| `/mode` | ✓ | ✓ | ✓ | 모드 전환 (Shift+Tab) |

## 전역 설치

`sleep-code` 명령어를 어디서든 사용하려면 전역 설치하세요:

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

## PM2 백그라운드 실행

PM2를 사용하면 봇을 백그라운드에서 실행하고 부팅 시 자동 시작할 수 있습니다.

### PM2 설치

```bash
npm install -g pm2
```

### 봇 시작

```bash
cd /path/to/sleep-code

# 특정 봇 시작
pm2 start ecosystem.config.cjs --only sleep-telegram
pm2 start ecosystem.config.cjs --only sleep-discord
pm2 start ecosystem.config.cjs --only sleep-slack

# 모든 봇 시작
pm2 start ecosystem.config.cjs
```

### 모니터링 및 관리

```bash
pm2 status                # 실행 중인 프로세스 목록
pm2 logs                  # 모든 로그 보기
pm2 logs sleep-discord    # 특정 봇 로그 보기
pm2 monit                 # 실시간 모니터링 대시보드
```

### 프로세스 제어

```bash
pm2 restart sleep-discord   # 특정 봇 재시작
pm2 restart all             # 모든 봇 재시작
pm2 stop sleep-discord      # 특정 봇 중지
pm2 stop all                # 모든 봇 중지
```

### 부팅 시 자동 시작

```bash
# 시작 스크립트 생성 (한 번만 실행)
pm2 startup

# 현재 프로세스 목록 저장
pm2 save
```

## 작동 방식

1. `npm run discord/telegram/slack`으로 세션을 대기하는 봇 시작
2. `npm run claude`로 PTY에서 Claude를 생성하고 Unix 소켓으로 봇에 연결
3. 봇이 Claude의 JSONL 파일을 감시하고 메시지를 채팅으로 전달
4. 채팅에서 보낸 메시지를 터미널로 전달
5. 권한 요청을 채팅으로 전달하여 승인 (Discord/Slack)

## 아키텍처

```
src/
├── cli/           # CLI 진입점 및 명령어
│   ├── index.ts   # 메인 CLI 진입점
│   ├── run.ts     # 세션 러너 (PTY + JSONL 감시)
│   └── {telegram,discord,slack}.ts  # 플랫폼별 설정/실행
├── discord/
│   ├── discord-app.ts      # Discord.js 앱 및 이벤트 핸들러
│   ├── channel-manager.ts  # 스레드/채널 관리
│   ├── process-manager.ts  # 세션 생성 및 생명주기
│   └── settings-manager.ts # 사용자 설정 (디렉토리, 터미널 앱)
├── slack/
│   ├── slack-app.ts        # Slack Bolt 앱
│   └── session-manager.ts  # JSONL 감시, 플랫폼 간 공유
└── telegram/
    └── telegram-app.ts     # grammY 앱 및 이벤트 핸들러
```

## 경고: YOLO 모드

> **YOLO 모드 사용에 따른 책임은 본인에게 있습니다.**

YOLO 모드(`/yolo-sleep` 또는 YOLO 버튼)는 **모든** 권한 요청을 확인 없이 자동 승인합니다. 이는 Claude가 다음을 수행할 수 있음을 의미합니다:

- 모든 쉘 명령어 실행
- 파일 읽기, 쓰기, 삭제
- 네트워크 요청
- 패키지 설치

작업을 완전히 신뢰하고 위험을 이해하는 경우에만 YOLO 모드를 활성화하세요. **YOLO 모드가 활성화된 동안 수행된 모든 작업에 대한 책임은 사용자에게 있습니다.**

## 면책 조항

이 프로젝트는 Anthropic과 관련이 없습니다. 사용에 따른 책임은 본인에게 있습니다.

## 라이선스

MIT
