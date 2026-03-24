# Lazy Resume Ghost Session 5Why Reply

## Verdict

가장 가능성 높은 실제 트리거는 **PM2 orphan 프로세스**입니다. 다만 더 근본 원인은 그 위에 있는 **lazy resume의 소유권/단일 진입(single-flight) 부재**입니다.

- PM2 orphan가 있으면 서로 다른 프로세스가 같은 Discord 이벤트를 동시에 처리할 수 있습니다.
- 현재 lazy resume은 "이 세션을 지금 누가 소유하고 있는가"를 확인하거나 잠그지 않습니다.
- 그래서 같은 persisted session/thread를 두 프로세스가 동시에 resume할 수 있고, 그 결과 한쪽 프로세스가 만든 세션은 다른 쪽 프로세스에서 인터럽트할 수 없는 "제어 불가 세션"처럼 보입니다.

## 5Why

### 문제

Lazy resume 후 세션이 두 개 생기고, `!잠깐`으로도 멈출 수 없다.

### Why 1

왜 두 개가 동시에 응답하고 인터럽트가 실패하는가?

- 같은 Discord thread에 대해 **둘 이상의 Claude SDK stream**이 살아 있습니다.
- 그런데 인터럽트는 현재 프로세스의 [`claudeSdkSessionManager.sessions`](./lazy-resume-ghost-session-discussion.md)에 들어 있는 엔트리만 대상으로 합니다.
- 따라서 실제로 응답 중인 stream이 다른 프로세스 쪽 것이면, 현재 프로세스는 `No active session to interrupt`를 반환할 수 있습니다.

근거:
- [`src/discord/discord-app.ts:283`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/discord-app.ts#L283 ) 부근에서 인터럽트는 `claudeSdkSessionManager.getSession(claudeSessionId)` 결과에만 의존합니다.
- 라우팅은 [`src/discord/channel-manager.ts:919`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/channel-manager.ts#L919 ) 의 `sdkStore.getByThread()` 기준입니다.

### Why 2

왜 둘 이상의 stream이 같은 thread/session에 대해 살아 있을 수 있는가?

- lazy resume 호출부가 [`src/discord/discord-app.ts:408`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/discord-app.ts#L408 ) 에서 `getSession()`으로 "현재 세션 없음"을 확인한 뒤 바로 `startSession()`을 호출합니다.
- 그런데 이 경로에는 **resume in flight 락**이 없습니다.
- `startSession()`도 [`src/discord/claude-sdk/claude-sdk-session-manager.ts:95`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/claude-sdk/claude-sdk-session-manager.ts#L95 ) 에서 기존 동일 `sessionId` 실행을 거부하지 않고 새 `entry`를 만들어 `this.sessions.set(id, entry)`로 덮어씁니다.

즉, 중복 resume가 발생하면:
- 이전 stream은 자기 `entry` 클로저를 들고 계속 돌 수 있고
- 새 stream은 `sessions` 맵의 현재 엔트리가 되며
- 제어 API는 맵에 남은 쪽만 봅니다.

### Why 3

왜 중복 resume가 실제로 발생했을 가능성이 높은가?

- PM2 설정이 [`ecosystem.config.cjs`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/ecosystem.config.cjs ) 에서 `script: 'npm'`, `args: 'run discord'`입니다.
- 이 구성은 PM2가 `npm` 부모 프로세스를 관리하고, 실제 `node dist/cli/index.js discord` 자식 프로세스가 orphan으로 남을 위험이 있습니다.
- orphan old process와 new process가 동시에 같은 bot token으로 연결되어 있으면, 같은 Discord 메시지를 둘 다 처리하고 둘 다 lazy resume할 수 있습니다.

이 로그 패턴과 특히 잘 맞는 부분:
- **turn 2 응답과 turn 1 응답이 섞임**
- 한쪽은 기존 메모리 세션을 이어가고, 다른 한쪽은 재시작 후 lazy resume한 새 세션이라고 보면 자연스럽습니다.

### Why 4

왜 orphan만으로 끝나지 않고 "제어 불가" 상태까지 가는가?

- 세션 소유권이 **프로세스 전역으로 합의되지 않기 때문**입니다.
- persisted mapping은 thread -> sessionId 정도만 저장하고, "어느 프로세스/인스턴스가 현재 owner인가"를 저장하지 않습니다.
- 따라서 라우팅 계층과 실행 계층 사이에 authoritative owner가 없습니다.

구체적으로:
- `channelManager.sdkStore`는 thread 매핑을 알고
- 각 프로세스의 `ClaudeSdkSessionManager.sessions`는 자기 메모리 세션만 압니다.
- 둘 사이에 distributed ownership 검증이 없어서, Discord에서는 한 thread처럼 보이는데 실제 실행체는 여러 개가 될 수 있습니다.

### Why 5

왜 이런 구조가 생겼는가?

- lazy resume이 "재시작 후 편하게 이어 붙이기" 기능으로 구현되면서, **세션 재개를 상태 머신이 아니라 편의 분기**로 추가했기 때문입니다.
- 즉, 다음 성질이 빠져 있습니다:
  - idempotent resume
  - single owner lease
  - in-flight dedupe
  - stale stream fencing

결국 근본 원인은:

**"lazy resume이 단일 소유권을 보장하는 세션 상태 머신이 아니라, persisted mapping만 보고 낙관적으로 다시 띄우는 구조"** 입니다.

## 문서의 가설 중 동의/비동의

### 동의

- `Map A (sdkStore)`와 `Map B (sessions)`가 불일치할 수 있다는 큰 방향은 맞습니다.
- 그래서 라우팅과 제어가 어긋날 수 있다는 문제의식도 맞습니다.

### 비동의

`processQueryStream` 에러 후 `finalizeSession()`이 `sessions`에서 삭제했는데도 같은 `queryHandle`이 계속 살아서 유령 세션이 된다는 설명은 **현재 코드만 보면 약합니다**.

이유:
- [`src/discord/claude-sdk/claude-sdk-session-manager.ts:429`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/claude-sdk/claude-sdk-session-manager.ts#L429 ) 의 `for await`가 끝나거나 throw한 뒤에야 `finally`가 실행됩니다.
- `finally` 안에서 `session.activeQuery = null`을 먼저 하고, 그 다음 unexpected 종료면 `onError -> finalizeSession`으로 갑니다.
- 즉, `finalizeSession()`은 **stream이 이미 끝난 뒤** 호출되는 구조이지, 살아 있는 stream을 먼저 map에서 떼어내는 구조는 아닙니다.

따라서 "에러 후 재생성인데 이전 query handle이 계속 살아 있었다"보다는:

- **다른 프로세스의 기존 stream이 계속 살아 있었거나**
- **같은 프로세스에서 중복 `startSession()`으로 덮어쓴 이전 entry가 계속 살아 있었거나**

이 둘이 더 직접적인 설명입니다.

## 원인 우선순위

1. **가장 가능성 높음: PM2 orphan + lazy resume 중복**
2. **그 다음: 동일 프로세스 내 lazy resume race**
3. **가능성 낮음: `processQueryStream` error/finalize만으로 살아 있는 queryHandle이 유령화**

## 왜 PM2 orphan를 1순위로 보는가

로그의 "turn 2와 turn 1이 섞임"이 중요합니다.

- 한 프로세스 안의 단순 재-resume이면 대개 기존 live session 대신 새 entry가 덮이거나 둘 다 turn 1 계열로 보일 가능성이 큽니다.
- 반면 **old orphan process가 기존 live session(turn 2)을 계속 진행**하고, **new process가 같은 persisted mapping을 lazy resume(turn 1)** 하면 현재 로그와 거의 일치합니다.
- `!잠깐` 실패도 "내가 보고 있는 프로세스의 세션은 running이 아닌데, 다른 프로세스 쪽 세션이 실제로 tool call 중"이라고 보면 깔끔하게 설명됩니다.

## 해결 방향

### 1. 운영 레벨

PM2에서 `npm run discord`를 직접 실행하지 말고 실제 node 엔트리포인트를 실행해야 합니다.

예:
- `script: 'dist/cli/index.js'`
- `args: 'discord'`

핵심은 PM2가 `npm`이 아니라 실제 long-lived node 프로세스를 직접 관리하게 만드는 것입니다.

### 2. 코드 레벨: single-flight

lazy resume 전에 `sessionId` 또는 `threadId` 기준으로 in-flight 락이 필요합니다.

예:
- `resumePromises: Map<string, Promise<ClaudeSdkSessionEntry>>`
- 이미 resume 중이면 기존 Promise를 await
- resume 완료/실패 시 해제

이거 없으면 한 프로세스 안에서도 중복 `startSession()`이 가능합니다.

### 3. 코드 레벨: startSession fencing

`startSession()`은 동일 `sessionId`가 이미 live면:
- 기존 엔트리를 반환하거나
- 명시적으로 실패해야 합니다.

지금처럼 무조건 `this.sessions.set(id, entry)` 하면 stale entry가 map 밖에서 계속 살아 있는 구조를 만들 수 있습니다.

### 4. 코드 레벨: owner token

각 session entry에 `instanceId` + `generation` 같은 owner token을 붙이고:
- 이벤트 처리
- interrupt
- finalize
- Discord post

모두 현재 owner와 일치하는지 확인해야 합니다.

이 fencing이 있으면 stale/orphan stream이 메시지를 보내더라도 무시할 수 있습니다.

### 5. 관측성

최소한 아래는 로그에 남겨야 합니다.

- process pid
- bot instance UUID
- sessionId
- sdkSessionId
- threadId
- "lazy resume started/finished"
- "interrupt requested on pid X"

지금 버그는 증상이 Discord 한 화면에 섞여 보여서, 어느 프로세스가 보낸 메시지인지 안 보이는 점이 디버깅을 어렵게 만듭니다.

## Short Answer

정리하면:

- **실제 촉발 요인**은 PM2 orphan가 가장 유력합니다.
- **근본 원인**은 lazy resume에 single owner / single-flight / fencing이 없는 설계입니다.
- 문서의 "error 후 finalize가 살아 있는 query를 유령화" 가설은 현재 코드 기준으로는 1순위 원인으로 보기 어렵습니다.
