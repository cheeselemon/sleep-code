# Phase 1 Report

## Scope

구현 범위:

- Claude Agent SDK 기반 session manager 추가
- Discord thread로 기본 송수신 연결
- `/claude start-sdk` slash/select flow 추가
- `channel-manager`에 SDK 세션 tracking/persistence 추가
- Discord app message routing에 SDK Claude 경로 추가

제외:

- Discord permission button 연동 (`canUseTool`은 auto-allow)
- partial streaming (`includePartialMessages: false`)
- SDK session restore/resume startup flow
- `/claude stop`, `/claude status`, `/status`, `/panel`의 SDK UX 보강

## Changes

### `src/discord/claude-sdk/claude-sdk-session-manager.ts`

신규 파일 추가.

- `ClaudeSdkSessionEntry` 정의
- `query()` + async generator 기반 멀티턴 입력 루프 구현
- `sendInput()`:
  - `pendingInputResolve`가 있으면 즉시 전달
  - 없으면 `idle/running` 구분 없이 큐 적재
- `interruptSession()`:
  - `Query.interrupt()` 호출
  - `turnAbortController`는 turn 종료 후 재생성
- `stopSession()`:
  - session/turn abort
  - pending input cleanup
  - query close
  - session 제거
- `ClaudeTransport` 구현 포함
- Phase 1 규칙대로 `canUseTool`은 전부 allow

### `src/discord/claude-sdk/claude-sdk-handlers.ts`

신규 파일 추가.

- SDK 이벤트를 Discord thread 메시지로 변환
- `onSessionStart` / `onSessionEnd`
- `onSessionStatus`
  - typing indicator 시작/정지
  - `channelManager.updateSdkStatus()` 반영
- `onMessage`
  - 텍스트 chunking 후 thread 전송
  - multi-agent thread에서는 Codex로 auto-route 지원
- `onToolCall`
  - tool name + 요약 input 표시
- `onToolResult`
  - `tool_use_summary` 기반 결과 알림
- `onError`
  - thread에 에러 표시

### `src/discord/channel-manager.ts`

Claude SDK 세션용 병렬 구조 추가.

- `sdkSessions`
- `threadToSdkSession`
- `sdkPersistedMappings`
- `sdk-session-mappings.json`

추가 메서드:

- `createSdkSession()`
- `getSdkSession()`
- `getSdkSessionByThread()`
- `updateSdkStatus()`
- `setSdkSessionId()`
- `getPersistedSdkMappings()`
- `archiveSdkSession()`

또한 `getAgentsInThread()`는 PTY Claude가 없으면 SDK Claude를 `claude` 슬롯으로 반환한다.

### `src/discord/discord-app.ts`

- `ClaudeSdkSessionManager` 생성
- `createClaudeSdkHandlers()` 연결
- `commandContext` / `handlerContext` / `interactionContext`에 주입
- `MessageCreate`에서 Claude target이 SDK session이면 `claudeSdkSessionManager.sendInput()`으로 라우팅
- Codex auto-create 시 CWD lookup이 PTY/SKD Claude 모두에서 동작하도록 수정
- user memory collect 시 project lookup도 PTY/SDK 공용으로 수정

### Slash Command / Interaction

추가/수정:

- `src/discord/commands/index.ts`
  - `/claude start-sdk` 등록
- `src/discord/commands/claude.ts`
  - `start-sdk` 핸들러 추가
  - directory select custom id: `claude_sdk_start_dir`
- `src/discord/interactions/select-menus.ts`
  - `handleSdkStartDirSelect()` 추가
- `src/discord/interactions/index.ts`
  - `claude_sdk_start_dir` 라우팅 추가

### Context / Cross-Agent Wiring

타입 주입:

- `src/discord/commands/types.ts`
- `src/discord/interactions/types.ts`
- `src/discord/handlers/types.ts`

또한 `src/discord/codex/codex-handlers.ts`를 수정해서, Codex가 `@claude`로 라우팅할 때 대상 Claude가 SDK session이면 SDK manager로 보내도록 연결했다.

## Compatibility

PTY 경로는 유지했다.

- 기존 `SessionManager` 기반 Claude PTY 흐름 유지
- 기존 slash command, select menu, Codex routing의 PTY 경로 유지
- SDK Claude는 별도 map/persistence를 사용하므로 PTY mapping을 덮어쓰지 않음

즉 Phase 1 도입 후에도 PTY 세션은 기존 방식 그대로 동작해야 한다.

## Validation

빌드 확인:

```bash
npm run build
```

결과: 성공

## Notes

- 사용자가 이미 `@anthropic-ai/claude-agent-sdk` 설치를 완료한 상태에서 작업을 진행했다.
- SDK session ID는 Phase 1에서는 `query()` 옵션의 `sessionId`로 직접 고정해서 app session ID와 동일하게 사용한다.
- permission/YOLO/Discord approve flow는 Phase 2 작업으로 남겨 두었다.
- restore/startup resume는 persistence 저장까지는 넣었지만 실제 복구 흐름은 Phase 3에서 마무리해야 한다.
