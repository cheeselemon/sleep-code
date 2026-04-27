# Codex Integration

Sleep Code는 Discord에서 Claude Code 세션과 함께 OpenAI Codex CLI 세션을 실행하고 제어할 수 있다. Claude가 PTY + JSONL 기반으로 동작하는 것과 달리, Codex는 `@openai/codex-sdk`를 직접 사용하여 프로그래밍 방식으로 제어된다.

## 설정

### 인증

다음 중 하나가 필요하다:

1. **OPENAI_API_KEY 환경변수** - `.env` 파일 또는 시스템 환경변수에 설정
2. **Codex OAuth** - `codex login` 실행 후 `~/.codex/auth.json` 자동 생성

봇 시작 시 자동 감지되며, 두 방법 모두 없으면 Codex가 비활성화된다.

```
// src/cli/discord.ts
const openaiKey = config.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const codexAuthFile = `${homedir()}/.codex/auth.json`;
const enableCodex = hasCodexOAuth || !!openaiKey;
```

### Codex 활성화 확인

봇 로그에서 확인 가능:
- `Codex enabled via OAuth (~/.codex/auth.json)` - OAuth 인증
- `Codex enabled via API key` - API 키 인증
- `No Codex auth found (run codex login or set OPENAI_API_KEY), Codex disabled` - 비활성화

## Discord 명령어

### `/codex start`

새 Codex 세션을 시작한다. **2단계 선택 메뉴**가 표시된다:

1. **모델 + 추론 강도 선택**: 9개 옵션 (예: `GPT-5.5 (high)`, `GPT-5.4-mini (medium)` 등)
2. **디렉토리 선택**: 화이트리스트된 디렉토리 중 하나

선택 사항은 세션에 고정되어 봇 재시작 시에도 복원된다 (`codex-session-mappings.json`에 저장).

현재 `/codex start` 메뉴가 노출하는 9개 모델+effort 조합:

| 모델 | `/codex start`에서 제공하는 effort | 설명 |
|------|------------------------------------|------|
| `gpt-5.5` | low / medium / high / xhigh | Frontier · 기본 effort `high` · `xhigh`는 가장 깊은 추론 |
| `gpt-5.4` | medium / high | 이전 세대 |
| `gpt-5.4-mini` | medium | 더 작고 빠르고 저렴 |
| `gpt-5.3-codex` | high | 코딩 특화 |
| `gpt-5.2` | medium | 레거시 |

세션이 시작된 뒤에는 `/codex intelligence`에서 전체 effort 범위(`minimal / low / medium / high / xhigh`)를 자유롭게 전환할 수 있다.

- `/claude add-dir`로 사전에 디렉토리를 등록해야 한다
- Claude와 동일한 디렉토리 화이트리스트를 공유한다
- 새 Discord 스레드가 생성되고 세션이 시작된다

### `/codex stop`

실행 중인 Codex 세션을 종료한다. 세션 선택 드롭다운이 표시되며, 현재 스레드의 세션에는 별표가 붙는다.

- 실행 중인 턴이 있으면 abort된다
- 스레드가 아카이브된다 (같은 스레드에 Claude가 없는 경우에만)
- 큐에 쌓인 입력은 폐기된다 (drop count 로깅)

### `/codex intelligence`

현재 스레드의 Codex 세션 추론 강도를 **실행 중에 변경**한다. 컨텍스트 손실 없음.

- 현재 effort가 선택지에서 default로 표시된다
- 활성 턴이 있으면 abort 후 새 effort로 thread 재개 (`resumeThread()`)
- 모델 + sandbox 모드 + cwd는 유지됨
- 이미 같은 effort 선택 시 no-op

```
/codex intelligence
  → "🧠 Change Codex Reasoning Effort
     Model: gpt-5.5 · Current: high"
  → 드롭다운에서 새 강도 선택
  → ✅ "GPT-5.5 · high → xhigh"
```

### `/codex status`

모든 Codex 세션의 상태를 Embed 카드로 표시한다.

| 상태 | 아이콘 | 설명 |
|------|--------|------|
| starting | 🔄 | 세션 시작 중 |
| running | 🟢 | 턴 실행 중 |
| idle | 🟡 | 대기 중 (입력 가능) |
| ended | ⚫ | 종료됨 |

### `/yolo-sleep` (Codex 스레드에서)

YOLO 모드를 토글한다. Codex의 sandbox 모드가 함께 전환된다:

- ON: `workspace-write` (파일 수정 허용)
- OFF: `read-only` (읽기 전용)

전환 시 활성 턴은 abort되고 thread가 새 sandbox 모드로 재개된다.

## 메시지 라우팅

### 단일 에이전트 스레드

- Claude만 있는 스레드: 모든 메시지가 Claude로 전달
- Codex만 있는 스레드: 모든 메시지가 Codex로 전달

### 멀티 에이전트 스레드

같은 스레드에 Claude와 Codex가 모두 있을 때:

1. **기본 동작**: 마지막으로 활성화된 에이전트에게 메시지가 전달된다
2. **명시적 접두어**: 접두어로 대상 에이전트를 지정할 수 있다

| 접두어 | 대상 | 예시 |
|--------|------|------|
| `c:` 또는 `claude:` | Claude | `c: 이 코드 설명해줘` |
| `x:` 또는 `codex:` | Codex | `x: 테스트 실행해줘` |
| (없음) | 마지막 활성 에이전트 | `버그 수정해줘` |

접두어는 대소문자를 구분하지 않는다.

### 자동 Codex 세션 생성

Claude 전용 스레드에서 `x:` 접두어를 사용하면, 해당 스레드에 Codex 세션이 자동으로 생성된다. Claude 세션의 작업 디렉토리를 상속받는다.

## 아키텍처

```
src/discord/codex/
├── codex-session-manager.ts   # SDK 세션 관리, 스트리밍 턴 처리
└── codex-handlers.ts          # Codex 이벤트 → Discord 메시지 변환
```

### CodexSessionManager

Codex SDK 세션의 생명주기를 관리한다.

```typescript
class CodexSessionManager {
  startSession(cwd, discordThreadId, { sandboxMode?, model?, modelReasoningEffort? })
  sendInput(sessionId, prompt)        // 큐잉 + 자동 drain
  stopSession(sessionId)              // 종료 (큐 비움 + abort)
  switchSandboxMode(sessionId, newMode)  // sandbox 전환 (yolo 토글이 호출)
  switchReasoningEffort(sessionId, newEffort)  // /codex intelligence가 호출
  interruptSession(sessionId)         // 활성 턴만 abort (세션 유지)
  restoreSessions(mappings)           // 봇 재시작 시 호출 (workingDirectory 포함)
  getSession(sessionId)
  getSessionByDiscordThread(threadId)
  getAllSessions()
}
```

핵심 설정:
- `approval_policy: 'never'` - 모든 작업을 자동 승인 (interactive approval 없음)
- 모델 + reasoning effort는 세션 entry에 고정 — `restoreSessions`/`switchSandboxMode`에서도 보존
- 입력 큐잉 - 활성 턴 중 들어온 메시지는 폐기되지 않고 큐에 쌓였다가 turn 끝나면 `\n\n`으로 합쳐 한 turn으로 발송 (cap 10)

### 이벤트 시스템

`CodexEvents` 인터페이스를 통해 세션 이벤트를 처리한다:

| 이벤트 | 설명 | Discord 표시 |
|--------|------|--------------|
| `onMessage` | 에이전트 텍스트 응답 | 일반 메시지 (멀티에이전트 시 `**Codex:**` 접두어) |
| `onCommandExecution` | 명령어 실행 | 코드 블록 (`$ command` + 출력 + exit code) |
| `onFileChange` | 파일 변경 | `📝 File changes:` + 파일 목록과 diff 미리보기 |
| `onError` | 에러 발생 | `❌ **Codex Error:** {message}` |
| `onSessionStatus` | 상태 변경 | Typing indicator 시작/중지 |

### 스트리밍 처리

`processStreamedTurn()`이 Codex SDK의 스트리밍 API를 사용한다:

```
thread.runStreamed(prompt)
  → thread.started     // 스레드 ID 캡처
  → item.completed     // agent_message, command_execution, file_change
  → turn.completed     // 토큰 사용량 로깅
  → error              // 에러 전파
```

각 턴은 `AbortController`로 중단 가능하다. `/codex stop` 시 활성 턴이 abort된다.

### ChannelManager 확장

Codex 세션은 Claude 세션과 별도의 맵에서 관리된다:

```typescript
// Codex 전용 메서드
createCodexSession(sessionId, name, cwd, existingThreadId?)
getCodexSession(sessionId)
updateCodexSessionId(oldId, newId)
getCodexSessionByThread(threadId)
getAgentsInThread(threadId)  // { claude?: string, codex?: string }
archiveCodexSession(sessionId)
```

세션 매핑은 `codex-session-mappings.json`에 별도로 영속화된다.

## Claude와의 차이점

| | Claude Code | Codex |
|---|---|---|
| 통신 방식 | PTY + Unix socket + JSONL | SDK 직접 호출 |
| 권한 관리 | Permission hook (interactive buttons) | `approval_policy: 'never'` (자동 승인) |
| YOLO 모드 | `/yolo-sleep`으로 토글 | 항상 자동 승인 |
| 세션 복구 | JSONL 파일 기반 복구 가능 | `codexThreadId` 저장, 봇 재시작 시 `resumeThread()` 복구 |
| 프로세스 | 별도 터미널/백그라운드 프로세스 | 봇 프로세스 내 SDK 스레드 |
| 이벤트 형식 | JSONL 파일 감시 (chokidar) | SDK 스트리밍 이벤트 |

## 제한사항

- Codex 세션은 봇 재시작 시 `codexThreadId` 기반으로 자동 복구된다 (`resumeThread()`)
- 봇 재시작 후 sandbox 모드는 `read-only`로 초기화된다 (yolo 상태는 별도 영속화 안 됨)
- 명령어 출력은 1500자로 잘린다
- 파일 diff 미리보기는 200자로 잘린다
- Codex는 항상 자동 승인 모드로 실행된다 (권한 요청 UI 없음)
- 입력 큐 cap = 10 — 11번째 메시지부터 거부 (`session busy or ended` 응답)
- 동시에 하나의 턴만 실행되지만, 추가 메시지는 큐잉 후 자동 drain되므로 사용자 측에서 메시지 손실 없음
