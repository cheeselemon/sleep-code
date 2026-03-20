# `/claude start-sdk` 구현 계획 v2

Agent SDK (`@anthropic-ai/claude-agent-sdk`) 기반 세션을 기존 PTY 방식과 병행 운영.
Codex 리뷰 반영: transport 추상화 우선, 퍼미션 흐름 구체화, interrupt/stop 분리.

## PTY vs SDK 비교

| 항목 | PTY (기존) | SDK (신규) |
|------|-----------|-----------|
| 프로세스 | 외부 CLI + Unix socket | 인프로세스 (CLI subprocess) |
| 출력 | JSONL 파일 워칭 (간접) | async iterable (직접) |
| 입력 | socket → PTY stdin (CJK chunking) | async generator yield |
| 퍼미션 | hook 바이너리 → socket → daemon | canUseTool 콜백 (Promise) |
| 스트리밍 | PTY 스크래핑 + JSONL 파싱 | StreamEvent content_block_delta |
| 세션 재개 | CLI --resume | `resume: sessionId` 옵션 |
| 의존성 | node-pty, chokidar, Unix socket | agent-sdk 하나 |
| 인증 | CLI 상속 | `claude login` OAuth (Max 구독) |

---

## Phase 0: Transport 추상화 (SDK 도입 전 선행작업)

### 문제

현재 코드 전반에 "Claude = PTY" 가정이 하드코딩됨:

- `controls.ts`: `/interrupt`, `/compact`, `/model` 등이 `sessionManager.sendInput()`으로 PTY stdin에 직접 보냄
- `helpers.ts`: `getSessionFromChannel()`이 PTY 세션만 조회
- `agent-routing.ts`: Codex→Claude 라우팅이 `sessionManager.sendInput(agents.claude!, msg)`
- `handlers/session.ts`: 세션 종료가 `processManager` + PTY 흐름에 묶임

SDK 세션을 넣으면 이 모든 경로에서 충돌 발생.

### 해결: `ClaudeTransport` 인터페이스

```typescript
// src/discord/claude-transport.ts
interface ClaudeTransport {
  type: 'pty' | 'sdk';
  sessionId: string;

  // 공통 동작
  sendInput(text: string): boolean | Promise<boolean>;
  interrupt(): boolean | Promise<boolean>;
  stop(): Promise<void>;

  // Transport 능력 표시
  supportsTerminalControls: boolean;  // /background, /mode, /compact 등
  supportsModelSwitch: boolean;       // /model

  // 상태
  isActive(): boolean;
}
```

### 수정 대상

#### `helpers.ts` → transport-aware 조회

```typescript
export function getTransportFromChannel(
  channelId: string,
  context: CommandContext
): { transport: ClaudeTransport } | { error: string } {
  // 1. SDK 세션 확인
  const sdkSession = context.claudeSdkSessionManager?.getSessionByThread(channelId);
  if (sdkSession) return { transport: sdkSession.transport };

  // 2. PTY 세션 확인 (기존)
  const sessionId = context.channelManager.getSessionByChannel(channelId);
  if (sessionId) return { transport: createPtyTransport(sessionId, context.sessionManager) };

  return { error: 'No active session in this channel.' };
}
```

#### `controls.ts` → transport 분기

```typescript
export const handleInterrupt: CommandHandler = async (interaction, context) => {
  const result = getTransportFromChannel(interaction.channelId, context);
  if ('error' in result) { await interaction.reply(`⚠️ ${result.error}`); return; }

  const interrupted = await result.transport.interrupt();
  // ...

  // PTY 전용 컨트롤은 transport.supportsTerminalControls 체크
};

export const handleCompact: CommandHandler = async (interaction, context) => {
  const result = getTransportFromChannel(interaction.channelId, context);
  if ('error' in result) { await interaction.reply(`⚠️ ${result.error}`); return; }

  if (!result.transport.supportsTerminalControls) {
    await interaction.reply('⚠️ This command is not supported in SDK sessions.');
    return;
  }
  // ...
};
```

#### `agent-routing.ts` → transport-aware sendToTarget

`sendToTarget` 콜백이 이미 추상화되어 있으므로, 호출 측에서 transport 타입에 따라 적절한 함수를 넘기면 됨. 수정 범위 작음.

#### PTY 전용 명령 정리

SDK thread에서의 동작:
| 명령 | SDK 동작 |
|------|----------|
| `/interrupt` | `abortController.abort()` (turn-level) |
| `/background` | ⚠️ 미지원 안내 |
| `/mode` | ⚠️ 미지원 안내 |
| `/compact` | ⚠️ 미지원 안내 (SDK가 자체 관리) |
| `/model` | 다음 turn의 `model` 옵션 변경 |
| `/panel` | interrupt + YOLO 버튼만 표시 |
| `/yolo-sleep` | `state.yoloSessions` 토글 (공통) |

---

## Phase 1: SDK 세션 매니저 + 기본 송수신

### 신규: `src/discord/claude-sdk/claude-sdk-session-manager.ts`

`codex-session-manager.ts` 패턴 참고.

```typescript
interface ClaudeSdkSessionEntry {
  id: string;                          // UUID (= sessionId)
  sdkSessionId: string;                // SDK가 부여한 실제 세션 ID
  cwd: string;
  discordThreadId: string;
  status: 'idle' | 'running' | 'ended';
  startedAt: Date;

  // 제어
  sessionAbortController: AbortController;    // 세션 전체 종료
  turnAbortController: AbortController;       // 현재 턴 중단 (interrupt)

  // 멀티턴
  pendingInputResolve: ((text: string | typeof END_SENTINEL) => void) | null;
  inputQueue: string[];
  maxQueueLength: number;              // 기본 10, overflow 시 거부

  // 퍼미션 (cleanup용 미러링)
  pendingPermissions: Map<string, { resolve: Function; toolName: string; input: unknown }>;

  // Transport 인터페이스 구현
  transport: ClaudeTransport;
}
```

주요 메서드:
- `startSession(cwd, threadId, options?)` — query() 시작, idle 상태로 대기
- `sendInput(sessionId, text)` — 입력 큐에 추가 or resolve pending
- `interruptSession(sessionId)` — `turnAbortController.abort()` → processQueryStream의 turn 종료 시점에서 idle 전이 (abort 직후 idle 전환 금지)
- `stopSession(sessionId)` — `sessionAbortController.abort()` → cleanup → ended
- `resumeSession(sessionId, threadId)` — `resume: sessionId` 옵션
- `getSessionByThread(threadId)` — thread로 세션 조회

### 멀티턴 async generator

```typescript
const END_SENTINEL = Symbol('end');

private async *createPromptGenerator(session: ClaudeSdkSessionEntry) {
  while (session.status !== 'ended') {
    const input = await new Promise<string | typeof END_SENTINEL>((resolve) => {
      // 큐에 이미 있으면 즉시 소비
      if (session.inputQueue.length > 0) {
        resolve(session.inputQueue.shift()!);
        return;
      }
      session.pendingInputResolve = resolve;
    });

    // 종료 sentinel
    if (input === END_SENTINEL) break;

    yield input;
  }
}
```

### `sendInput()` 정책

```typescript
sendInput(sessionId: string, text: string): boolean {
  const session = this.sessions.get(sessionId);
  if (!session || session.status === 'ended') return false;

  if (session.pendingInputResolve) {
    // generator가 대기 중 → 즉시 전달
    session.pendingInputResolve(text);
    session.pendingInputResolve = null;
  } else {
    // generator가 아직 await에 도달하지 않았거나, Claude가 응답 중
    // → idle/running 구분 없이 무조건 큐에 적재 (상태 전이 타이밍 무관)
    if (session.inputQueue.length >= session.maxQueueLength) {
      return false; // 큐 오버플로우
    }
    session.inputQueue.push(text);
  }
  return true;
}
```

### `interruptSession()` vs `stopSession()`

```typescript
interruptSession(sessionId: string): boolean {
  const session = this.sessions.get(sessionId);
  if (!session || session.status !== 'running') return false;

  // 현재 턴만 중단 — abort만 호출, idle 전이는 processQueryStream의
  // turn 종료(finally) 시점에서 수행. Codex 패턴과 동일.
  // 이렇게 해야 abort 직후 새 turn이 겹치는 레이스를 방지.
  session.turnAbortController.abort();
  // 새 controller 생성과 idle 전이는 processQueryStream에서:
  // } finally {
  //   if (session.turnAbortController.signal.aborted) {
  //     session.turnAbortController = new AbortController();
  //   }
  //   if (session.status !== 'ended') session.status = 'idle';
  // }
  return true;
}

async stopSession(sessionId: string): Promise<boolean> {
  const session = this.sessions.get(sessionId);
  if (!session || session.status === 'ended') return false;

  session.status = 'ended';

  // pending input 정리
  if (session.pendingInputResolve) {
    session.pendingInputResolve(END_SENTINEL);
    session.pendingInputResolve = null;
  }

  // pending permissions 정리
  for (const [reqId, perm] of session.pendingPermissions) {
    perm.resolve({ behavior: 'deny' });
    this.state.pendingPermissions.delete(reqId);
  }
  session.pendingPermissions.clear();

  // 세션 전체 중단
  session.sessionAbortController.abort();
  session.inputQueue.length = 0;

  this.sessions.delete(sessionId);
  this.events.onSessionEnd(sessionId);
  return true;
}
```

### 신규: `src/discord/claude-sdk/claude-sdk-handlers.ts`

SDK 이벤트 → Discord 메시지 변환. `codex-handlers.ts` 패턴.

```typescript
interface ClaudeSdkEvents {
  onSessionStart(sessionId: string, cwd: string, threadId: string): void;
  onSessionEnd(sessionId: string): void;
  onMessage(sessionId: string, content: string): Promise<void>;
  onToolCall(sessionId: string, toolName: string, input: unknown): Promise<void>;
  onToolResult(sessionId: string, toolName: string, result: string, isError: boolean): Promise<void>;
  onPermissionRequest(sessionId: string, request: SdkPermissionRequest): void;
  onError(sessionId: string, error: Error): void;
}
```

---

## Phase 2: 퍼미션 핸들링

### 설계 원칙

1. **`state.pendingPermissions` 단일 소스** — PTY, SDK 모두 같은 Map 사용
2. **`state.yoloSessions` 단일 소스** — session.isYolo 별도 두지 않음
3. **기존 `handlePermissionButton` 그대로 사용** — resolve 인터페이스 동일
4. **SDK 전용 permission 전송 경로 신규 생성**

### `canUseTool` → Discord 버튼 흐름

```typescript
// claude-sdk-session-manager.ts 내부
canUseTool: async (toolName, input) => {
  // YOLO 체크: state.yoloSessions 조회 (session.isYolo X)
  const YOLO_EXCLUDED = new Set(['ExitPlanMode']);
  if (this.state.yoloSessions.has(session.id) && !YOLO_EXCLUDED.has(toolName)) {
    // YOLO 알림 전송
    this.events.onYoloApprove(session.id, toolName);
    return { behavior: 'allow' as const, updatedInput: input };
  }

  // Promise 생성 → resolve를 래핑해서 양쪽 cleanup 보장
  return new Promise((resolve) => {
    const requestId = randomUUID();

    // 래핑: 한 번만 호출되며, 양쪽 map을 동시에 정리
    let resolved = false;
    const wrappedResolve = (decision: { behavior: 'allow' | 'deny' }) => {
      if (resolved) return; // 중복 호출 방지 (timeout + 버튼 동시)
      resolved = true;
      resolve(decision);
      this.state.pendingPermissions.delete(requestId);
      session.pendingPermissions.delete(requestId);
    };

    // 1. state.pendingPermissions에 등록 (버튼 핸들러가 찾을 수 있도록)
    this.state.pendingPermissions.set(requestId, {
      requestId,
      sessionId: session.id,
      resolve: wrappedResolve,
    });

    // 2. session.pendingPermissions에도 등록 (세션 종료 시 cleanup용)
    session.pendingPermissions.set(requestId, { resolve: wrappedResolve, toolName, input });

    // 3. Discord에 버튼 전송
    this.events.onPermissionRequest(session.id, {
      requestId,
      toolName,
      toolInput: input as Record<string, unknown>,
    });
  });
}
```

### SDK 퍼미션 버튼 전송

`claude-sdk-handlers.ts`의 `onPermissionRequest` 구현:

```typescript
// 기존 permission.ts의 버튼 UI 생성 로직을 공유 함수로 추출
// → src/discord/handlers/permission-ui.ts
export function createPermissionButtons(requestId: string, toolName: string, toolInput: unknown) {
  // ActionRow + Allow/YOLO/Deny 버튼 반환
  // 기존 permission.ts에서 추출
}
```

`handlePermissionButton` (interactions/permissions.ts)는 **최소 수정**:
- `state.pendingPermissions.get(requestId)` → `wrappedResolve` 호출 (양쪽 map 자동 cleanup)
- 기존 코드는 `resolve()` 후 `state.pendingPermissions.delete()` 하는데, wrappedResolve가 이를 대신하므로 **중복 delete만 제거**
- YOLO 클릭 시 `state.yoloSessions.add(sessionId)` (SDK도 같은 state 사용)

### 퍼미션 타임아웃

```typescript
// canUseTool 내부, wrappedResolve 생성 후
setTimeout(() => {
  // wrappedResolve가 중복 호출 방지하므로, 이미 버튼으로 resolve됐으면 no-op
  wrappedResolve({ behavior: 'deny' });
  this.events.onPermissionTimeout(session.id, requestId, toolName);
}, this.permissionTimeoutMs); // 기본 5분
```

---

## Phase 3: 세션 관리 + Persistence

### `/claude start-sdk` 커맨드

`commands/index.ts`:
```typescript
.addSubcommand(sub =>
  sub.setName('start-sdk')
    .setDescription('Start a Claude session via Agent SDK'))
```

`commands/claude.ts`:
```typescript
if (subcommand === 'start-sdk') {
  // 디렉토리 선택 → customId: 'claude_sdk_start_dir'
}
```

`interactions/select-menus.ts`:
```typescript
handleSdkStartDirSelect:
  1. channelManager.createSession() (기존 재사용, sessionType: 'sdk')
  2. claudeSdkSessionManager.startSession(cwd, threadId)
  3. thread에 "SDK session started" 알림
```

### `/claude stop` + `/claude status` 업데이트

`/claude stop`: transport.type 확인 → SDK면 `claudeSdkSessionManager.stopSession()`
`/claude status`: PTY + SDK 세션 모두 표시, 타입 표시 (🔧 PTY / 📡 SDK)

### Persistence

파일: `~/.sleep-code/sdk-session-mappings.json` (Codex와 동일 패턴)

```typescript
interface SdkPersistedMapping {
  sessionId: string;
  sdkSessionId: string;
  threadId: string;
  channelId: string;
  cwd: string;
}
```

저장 시점: `startSession()` 성공 후
삭제 시점: `stopSession()` 또는 thread 아카이브 시

### Startup Restore

`discord.ts` startup에서 (Codex restore와 동일 패턴):

```typescript
// SDK session restore
const sdkMappings = await loadSdkMappings();
for (const mapping of sdkMappings) {
  // thread 존재 확인
  // thread가 archived → Restore/Dismiss 버튼 (기존 restore 로직 재사용)
  // thread가 살아있으면 → resumeSession() 시도
}
```

### Resume 흐름

```typescript
async resumeSession(sessionId: string, threadId: string): Promise<ClaudeSdkSessionEntry> {
  const persisted = this.loadPersistedMapping(sessionId);
  if (!persisted) throw new Error('No persisted session found');

  // query()에 resume 옵션
  const entry = this.createEntry(persisted.cwd, threadId);
  entry.sdkSessionId = persisted.sdkSessionId;

  this.processQueryStream(entry, {
    resume: persisted.sdkSessionId,
  });

  return entry;
}
```

---

## Phase 4: 스트리밍 + 연동

### 스트리밍 (선택적)

```typescript
// query() 옵션
includePartialMessages: settings.sdkStreamingEnabled

// processQueryStream 내부
if (message.type === 'stream_event') {
  const event = message.event;
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    streamBuffer += event.delta.text;
    // 800ms 디바운스 or 300자 초과 시 Discord 메시지 edit
  }
}
```

Discord 제한: 채널당 ~5 msg/sec, edit ~10/sec
- Phase 1에서는 비활성화 (완성 메시지만)
- Phase 4에서 활성화 옵션 추가

### 도구 호출/결과 표시

기존 `handlers/tool.ts` 패턴 재사용:
- 도구 호출: `🔧 **{toolName}**` + input 요약
- 도구 결과: 300자 초과 시 "View Full" 버튼

### 메모리 수집기 연동

SDK 세션의 AssistantMessage를 기존 `MemoryCollector`에 주입.
`onMessage` 이벤트에서 `memoryCollector.onMessage()` 호출.

### Agent 라우팅 (Phase 0에서 함께 구현)

`agent-routing.ts`의 `sendToTarget` 콜백을 transport-aware로:
- SDK 세션이면 `claudeSdkSessionManager.sendInput()`
- PTY 세션이면 `sessionManager.sendInput()` (기존)
- `getTransportFromChannel()`로 통일 조회

`getAgentsInThread()` 업데이트:
```typescript
getAgentsInThread(threadId: string) {
  return {
    claude: this.threadToSession.get(threadId)      // PTY
          || this.threadToSdkSession.get(threadId),  // SDK
    codex: this.threadToCodexSession.get(threadId),
  };
}
```

한 thread에 PTY와 SDK가 동시에 있을 수 없도록 `start-sdk` 시 기존 PTY 세션 확인.

**중요**: agent routing은 Phase 0에서 transport 추상화와 함께 구현.
Phase 1~3 동안 SDK+Codex 공존 thread가 정상 동작하려면 routing이 먼저 있어야 함.

---

## 구현 순서 정리

| Phase | 내용 | 핵심 파일 |
|-------|------|----------|
| **0** | Transport 추상화 + agent routing 준비 | claude-transport.ts, helpers.ts, controls.ts, agent-routing.ts |
| **1** | SDK 세션 매니저 + 기본 송수신 | claude-sdk-session-manager.ts, claude-sdk-handlers.ts |
| **2** | 퍼미션/YOLO | canUseTool, permission-ui.ts, state 연동 |
| **3** | 세션 관리 + persistence + resume | stop/interrupt, mappings, startup restore |
| **4** | 스트리밍 + 도구 표시 + 메모리 | streaming, tool display, memory |

**Phase 제약**: Phase 0 완료 전까지 SDK thread에 Codex join 및 `@claude`/`@codex` agent routing 비지원. Phase 0에서 transport-aware routing을 함께 구현.

---

## 수정 파일 요약

| 파일 | 변경 내용 |
|------|----------|
| `package.json` | `@anthropic-ai/claude-agent-sdk` 추가 |
| `src/discord/claude-transport.ts` | **신규** — ClaudeTransport 인터페이스 |
| `src/discord/claude-sdk/claude-sdk-session-manager.ts` | **신규** — SDK 세션 관리 |
| `src/discord/claude-sdk/claude-sdk-handlers.ts` | **신규** — 이벤트→Discord |
| `src/discord/commands/helpers.ts` | `getTransportFromChannel()` 추가 |
| `src/discord/commands/controls.ts` | transport-aware 분기 |
| `src/discord/commands/claude.ts` | `start-sdk` 핸들러 |
| `src/discord/commands/index.ts` | `start-sdk` 서브커맨드 등록 |
| `src/discord/commands/types.ts` | context에 SDK manager 추가 |
| `src/discord/discord-app.ts` | SDK manager 생성/연결/라우팅 |
| `src/discord/channel-manager.ts` | SDK 세션 tracking 추가 |
| `src/discord/handlers/permission-ui.ts` | **신규** — 버튼 UI 공유 함수 추출 |
| `src/discord/interactions/select-menus.ts` | SDK 디렉토리 선택 핸들러 |
| `src/discord/interactions/index.ts` | SDK select menu 라우팅 |
| `src/discord/agent-routing.ts` | SDK transport 지원 |
| `src/discord/state.ts` | (변경 없음 — 기존 구조 재사용) |

---

## 리스크

| 리스크 | 대응 |
|--------|------|
| SDK 패키지 불안정 | 버전 고정, 추상화 레이어 |
| headless/PM2에서 OAuth 안 될 수 있음 | `start-sdk` 시 auth 체크, 에러 메시지 |
| 장시간 query() 행 | sessionAbortController + health check |
| 스트리밍 Discord rate limit | Phase 1은 non-streaming, Phase 4에서 800ms 배칭 |
| async generator 레이스 컨디션 | 큐 + sentinel + abort-aware promise |
| canUseTool Promise 미응답 | 5분 타임아웃 → auto-deny + state cleanup |
| PTY 전용 명령이 SDK thread에서 실행 | `supportsTerminalControls` 체크, ⚠️ 안내 |
| YOLO state 불일치 | `state.yoloSessions` 단일 소스, session.isYolo 없음 |
| 같은 thread에 PTY+SDK 공존 | 시작 시 기존 세션 확인, 거부 |
| resume 시 SDK sessionId 누락 | persist 시점 명시, validation |

---

## Open Questions (결정 필요)

1. OAuth auth 체크 시점: `/claude start-sdk` 실행 시? 앱 시작 시?
   → **제안**: `/claude start-sdk` 실행 시. 앱 시작은 PTY만 써도 되니까.

2. SDK 세션이 `@claude` auto-route 대상이 되는가?
   → **제안**: 예. PTY든 SDK든 "Claude" 세션이므로 동일하게 라우팅.

3. `sessionType`을 `ChannelMapping`에 넣을지, SDK 전용 Map을 둘지?
   → **제안**: Codex 패턴 따라 SDK 전용 Map/persistence. 기존 Claude PTY 경로 오염 방지.

---

## 설정

`~/.sleep-code/settings.json`:
```json
{
  "sdkDefaultModel": "sonnet",
  "sdkMaxTurns": 100,
  "sdkPermissionTimeoutMs": 300000,
  "sdkStreamingEnabled": false
}
```

환경변수: `DISABLE_SDK_SESSIONS=1`로 비활성화 가능.
