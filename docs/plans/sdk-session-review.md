# `/claude start-sdk` 구현 계획 v2 리뷰

## Findings

### 1. `interruptSession()`이 turn 종료를 기다리지 않고 곧바로 `idle`로 바뀌어서, abort 직후 새 turn이 겹칠 수 있습니다.

v2는 turn-level/controller-level 분리를 도입한 점이 좋습니다. 다만 [`docs/plans/sdk-session-implementation.md`](./sdk-session-implementation.md) 153-154, 207-215의 `interruptSession()` 예시는 `turnAbortController.abort()` 직후 새 controller를 만들고 `session.status = 'idle'`로 바꿉니다. 이건 현재 Codex 구현이 이미 피하고 있는 레이스를 다시 열어 둡니다.

현재 [`src/discord/codex/codex-session-manager.ts`](../../src/discord/codex/codex-session-manager.ts)는 interrupt 시 바로 `idle`로 내리지 않고, 스트림이 실제로 unwind된 뒤 `finally`에서 stale controller를 확인한 다음 상태를 정리합니다. SDK도 같은 패턴이 필요합니다. 그렇지 않으면:

- abort 직후 사용자가 새 입력을 보내서 새 turn이 시작되고
- 이전 turn의 stream/finally가 늦게 정리되면서
- 상태 전이와 출력 순서가 꼬일 수 있습니다.

이 부분은 계획서에 "`interruptSession()`은 abort만 하고, `processQueryStream()`의 turn 종료 지점에서만 `idle` 전이"로 수정하는 편이 안전합니다.

### 2. 퍼미션 흐름은 많이 좋아졌지만, `handlePermissionButton`을 "수정 불필요"로 두면 `session.pendingPermissions`가 정리되지 않습니다.

v2는 `state.pendingPermissions`를 단일 소스로 되돌리고, 세션 로컬 map은 cleanup 용도로만 미러링하는 방향으로 정리했습니다. 이건 이전 버전보다 훨씬 낫습니다. 하지만 [`docs/plans/sdk-session-implementation.md`](./sdk-session-implementation.md) 291-299, 324-339를 그대로 구현하면 아직 문제가 남습니다.

- 버튼 클릭 시 기존 [`src/discord/interactions/permissions.ts`](../../src/discord/interactions/permissions.ts)는 `state.pendingPermissions`만 resolve/delete 합니다.
- 그런데 v2는 SDK 세션 쪽에도 `session.pendingPermissions`를 별도로 유지하고, timeout도 그 map을 기준으로 동작합니다.

이 상태로는 유저가 이미 Allow/Deny를 눌러도 `session.pendingPermissions`에 항목이 남아 있을 수 있습니다. 그러면:

- timeout callback이 나중에 다시 `deny`를 resolve하려고 하거나
- `stopSession()` cleanup에서 같은 resolver를 한 번 더 건드리게 됩니다.

즉 "버튼 핸들러 수정 불필요"는 아직 완전히 성립하지 않습니다. 해결 방법은 둘 중 하나입니다.

1. `resolve`를 래핑해서 한 번 호출되면 `state.pendingPermissions`와 `session.pendingPermissions`를 둘 다 제거하게 합니다.
2. SDK manager에 `clearPendingPermission(requestId)`를 두고, 버튼 핸들러가 decision 후 그 cleanup까지 호출하게 합니다.

추가로 v2의 `ClaudeSdkSessionEntry` 예시(128-147)에는 `pendingPermissions` 필드가 빠져 있는데, 아래 `stopSession()`과 timeout 예시는 그 필드를 사용합니다. 이건 계획서 내부 불일치이므로 같이 정리하는 편이 좋습니다.

### 3. `sendInput()` 예시는 `idle` 상태에서 `pendingInputResolve`가 아직 안 걸린 짧은 구간의 입력을 조용히 유실할 수 있습니다.

[`docs/plans/sdk-session-implementation.md`](./sdk-session-implementation.md) 185-200의 `sendInput()` 예시는 다음 두 경우만 처리합니다.

- `pendingInputResolve`가 있으면 즉시 전달
- `status === 'running'`이면 큐 적재

문제는 `status === 'idle'`인데 아직 generator가 다음 `await`에 도달하지 않아 `pendingInputResolve`가 없는 짧은 구간입니다. 이 경우 현재 예시는 아무 데도 넣지 않고 `true`를 반환합니다. 구현자가 예시를 그대로 따르면 입력이 소리 없이 사라집니다.

안전한 규칙은 더 단순합니다.

- `pendingInputResolve`가 있으면 즉시 전달
- 없으면 `idle`/`running`과 상관없이 큐에 넣기
- 큐 소비는 generator가 담당

지금처럼 `running`일 때만 queueing하는 정책은 상태 전이 타이밍에 민감해서 취약합니다.

### 4. Agent routing을 Phase 4로 미루면, SDK Claude가 `@claude` 대상이라고 정의한 순간부터 Codex 공존 thread에서 동작이 비게 됩니다.

v2는 transport abstraction을 Phase 0으로 당긴 점이 좋습니다. 하지만 [`docs/plans/sdk-session-implementation.md`](./sdk-session-implementation.md) 460-477, 481-489를 보면 SDK-aware agent routing은 여전히 Phase 4에 있습니다. 이건 계획서 자체의 다른 결정과 충돌합니다.

이미 v2는:

- SDK 세션도 `ClaudeTransport`로 노출하고
- Open Question에서 SDK 세션이 `@claude` auto-route 대상이라고 정했고
- 같은 thread에 Codex가 붙을 수 있는 전제를 유지합니다.

그러면 Codex가 있는 SDK thread에서는 `@claude` 라우팅이 처음부터 맞아야 합니다. 지금 순서대로면 `/claude start-sdk` + Codex 공존은 먼저 가능해지는데, Codex→Claude routing은 마지막 Phase까지 비어 있게 됩니다.

선택지는 둘 중 하나입니다.

1. `agent-routing` 지원을 Phase 0 또는 Phase 1로 당깁니다.
2. 그 전까지는 "SDK Claude thread에는 Codex join/agent-routing 비지원"을 계획서에 명시합니다.

지금 상태는 구현 순서만 따르면 중간 단계에서 부분적으로 깨진 multi-agent thread가 생깁니다.

## Improvements Confirmed

이전 리뷰의 큰 방향성 이슈는 대부분 반영됐습니다.

- Phase 0 transport abstraction 추가: 좋습니다. 기존 PTY 가정을 분리하는 첫 단계로 타당합니다.
- 퍼미션 상태 단일화: `state.pendingPermissions`와 `state.yoloSessions`를 기준으로 잡은 방향이 맞습니다.
- `interrupt` vs `stop` 분리: controller를 분리한 것은 필요했던 보완입니다.
- persistence 구체화: SDK 전용 mapping 파일과 startup restore 흐름이 들어왔습니다.
- phase ordering 개선: 최소한 transport abstraction이 MVP보다 앞에 와야 한다는 지적은 잘 반영됐습니다.

즉 v2는 "구조가 맞는가" 단계는 통과했고, 남은 건 경계 조건과 단계별 적용 순서입니다.

## Open Questions

- `/claude stop` UI는 현재 [`src/discord/commands/claude.ts`](../../src/discord/commands/claude.ts) 처럼 `processManager.getAllRunning()` 기반인데, SDK 세션을 어떤 목록/선택 UI로 합칠지 더 구체화하는 편이 좋습니다.
- SDK session ID가 언제 확정되는지에 따라 persistence 저장 시점은 "`startSession()` 성공 후"보다 "실제 `sdkSessionId` 확보 직후"가 더 안전할 수 있습니다.
- `getTransportFromChannel()` 예시는 thread 기준 SDK 조회만 보여주는데, parent channel에서도 동일한 UX를 유지할지 결정이 필요합니다.

## Recommendation

v2는 구현해도 될 수준까지 많이 정리됐습니다. 다만 위 4개는 실제 구현 단계에서 바로 버그로 번질 가능성이 높아서, 계획서에 먼저 못 박아 두는 편이 낫습니다.

우선순위는 이렇습니다.

1. `interruptSession()` 상태 전이 규칙 수정
2. permission resolve 시 양쪽 map cleanup 규칙 명시
3. `sendInput()` queue 규칙 단순화
4. agent routing phase 조정 또는 SDK+Codex 공존 제한 명시

이 4개만 정리되면, 남은 작업은 구현 세부로 내려가도 됩니다.
