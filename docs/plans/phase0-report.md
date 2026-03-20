# Phase 0 Report

## Scope

구현 범위:

- `ClaudeTransport` 추상화 추가
- command helper를 transport-aware 조회로 확장
- in-session control command를 transport-aware로 변경
- agent routing에 transport-aware target interface를 준비

제외:

- SDK 패키지 설치
- 실제 SDK session manager 구현
- Discord app wiring

## Changes

### `src/discord/claude-transport.ts`

신규 파일 추가.

- `ClaudeTransport` 인터페이스 정의
- `ClaudeTransportInputOptions` 추가 (`submit?: boolean`)
  - 기존 PTY 경로의 `submit=false` 동작을 유지하기 위해 계획안보다 한 단계 확장
- `ClaudeSdkSessionManagerLike` / `ClaudeSdkSessionLike` 타입 추가
  - Phase 1의 SDK manager 연결 지점
- `createPtyTransport()` 추가
  - 기존 `SessionManager`를 감싸서 transport 인터페이스로 노출
  - `interrupt()`는 기존과 동일하게 Escape x2
  - `supportsTerminalControls`, `supportsModelSwitch`는 `true`

### `src/discord/commands/types.ts`

- `claudeSdkSessionManager?: ClaudeSdkSessionManagerLike` 추가
- 아직 실제 구현은 없고, Phase 1에서 주입 예정

### `src/discord/commands/helpers.ts`

- `getTransportFromChannel()` 추가
  - SDK session manager가 있으면 thread 기준 SDK transport 반환
  - 없으면 기존 PTY session lookup으로 fallback
- 기존 `getSessionFromChannel()`은 그대로 유지

### `src/discord/commands/controls.ts`

`/interrupt`, `/background`, `/mode`, `/compact`, `/model`을 transport-aware로 변경.

- 공통적으로 `getTransportFromChannel()` 사용
- PTY 경로는 기존 동작 유지
- transport capability 체크 추가
  - terminal control 미지원이면 `⚠️ \`/...\` is not supported in SDK sessions.`
  - model switch 미지원이면 동일 방식으로 안내
- `/interrupt`는 `transport.interrupt()` 사용
- Codex 동시 interrupt 로직은 그대로 유지

### `src/discord/agent-routing.ts`

- `AgentRouteTarget` 인터페이스 추가
  - `agent`
  - `transportType?`
  - `isAvailable()`
  - `send()`
- `RouteParams`에 optional `target` 추가
- 기존 `sendToTarget` / `isTargetAvailable` 호출 방식은 그대로 지원

즉 현재 호출부는 수정 없이 동작하고, Phase 1에서 SDK Claude target을 넘길 수 있는 준비만 끝낸 상태다.

## Compatibility

PTY 경로 회귀 방지 확인:

- `getSessionFromChannel()` 유지
- `controls.ts`의 PTY command payload 유지
  - background: `\x02`
  - interrupt: Escape x2
  - mode: `\x1b[Z`
  - compact: `/compact\n`
  - model: `/model ...`
- `submit=false` semantics 유지
- Codex interrupt 병행 처리 유지

현재 repo에는 SDK manager 구현이 없으므로, 새 transport abstraction은 실질적으로 PTY fallback만 사용한다. 따라서 Phase 0 단독 적용 시 런타임 동작 변화는 없어야 한다.

## Validation

빌드 확인:

```bash
npm run build
```

결과: 성공

## Follow-up for Phase 1

- `claudeSdkSessionManager` 실제 구현 및 `discord-app.ts` 주입
- `getTransportFromChannel()`의 SDK lookup 활성화
- `agent-routing.ts` 호출부에서 SDK Claude target 전달
- `/panel`, `/yolo-sleep`, `/status`도 transport-aware로 정리 여부 검토
