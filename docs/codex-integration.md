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

새 Codex 세션을 시작한다. 허용된 디렉토리 목록에서 선택하는 드롭다운 메뉴가 표시된다.

- `/claude add-dir`로 사전에 디렉토리를 등록해야 한다
- Claude와 동일한 디렉토리 화이트리스트를 공유한다
- 새 Discord 스레드가 생성되고 세션이 시작된다

### `/codex stop`

실행 중인 Codex 세션을 종료한다. 세션 선택 드롭다운이 표시되며, 현재 스레드의 세션에는 별표가 붙는다.

- 실행 중인 턴이 있으면 abort된다
- 스레드가 아카이브된다 (같은 스레드에 Claude가 없는 경우에만)

### `/codex status`

모든 Codex 세션의 상태를 Embed 카드로 표시한다.

| 상태 | 아이콘 | 설명 |
|------|--------|------|
| starting | 🔄 | 세션 시작 중 |
| running | 🟢 | 턴 실행 중 |
| idle | 🟡 | 대기 중 (입력 가능) |
| ended | ⚫ | 종료됨 |

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
  startSession(cwd, discordThreadId)  // 새 세션 시작
  sendInput(sessionId, prompt)        // 사용자 입력 전달 (스트리밍)
  stopSession(sessionId)              // 세션 종료 (abort 포함)
  getSession(sessionId)               // 세션 조회
  getSessionByDiscordThread(threadId) // Discord 스레드로 세션 조회
  getAllSessions()                     // 전체 세션 목록
}
```

핵심 설정:
- `approval_policy: 'never'` - 모든 작업을 자동 승인 (interactive approval 없음)
- 동시 턴 방지 - `status === 'running'`이면 새 입력 거부

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
- 명령어 출력은 1500자로 잘린다
- 파일 diff 미리보기는 200자로 잘린다
- Codex는 항상 자동 승인 모드로 실행된다 (권한 요청 UI 없음)
- 동시에 하나의 턴만 처리 가능하다 (이전 턴 완료 전 새 입력 거부)
