# Lazy Resume 5Why Reply

## Scope

아래는 CEO 요청대로 세 문제를 **각각 독립된 5Why 체인**으로 분석한 결과입니다.

- 문제 1: 세션 이중 생성
- 문제 2: 인터럽트 불가
- 문제 3: 제어 불능

각 체인은 도요타 방식으로, 직전 답이 다음 "왜?"의 주어가 되도록 구성했습니다.

## Problem 1

### 문제

Lazy resume 시 같은 Discord 스레드에서 Claude SDK 세션이 두 개가 된다.

### 5Why

1. 왜 세션이 두 개가 되었나?
   같은 thread에 대해 **둘 이상의 Claude SDK stream**이 동시에 응답했기 때문이다.

   근거:
   - 원본 로그에서 3:52와 3:53 응답이 모두 `turn 1`이고 둘 다 모델 태그가 있다.
   - 이는 같은 세션의 연속 turn이 아니라, 별도 SDK 세션 둘이 각각 첫 turn을 수행했다는 뜻이다.

2. 왜 같은 thread에 대해 둘 이상의 Claude SDK stream이 동시에 응답했나?
   같은 persisted session/thread가 **중복 resume** 되었기 때문이다.

   근거:
   - lazy resume 분기에서 [`src/discord/discord-app.ts:408`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/discord-app.ts#L408 ) 이후 `getSession()` 결과가 없으면 바로 `startSession()`을 호출한다.
   - 중복 resume를 막는 락이나 이미 resume 중인지 확인하는 코드가 없다.

3. 왜 같은 persisted session/thread가 중복 resume될 수 있나?
   `startSession()`이 동일 `sessionId`의 기존 live 실행을 거부하지 않고 새 entry를 만들어 `sessions` 맵에 넣기 때문이다.

   근거:
   - [`src/discord/claude-sdk/claude-sdk-session-manager.ts:95`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/claude-sdk/claude-sdk-session-manager.ts#L95 ) 에서 `startSession()`은 기존 엔트리 검사 없이 새 `entry`를 만들고 [`src/discord/claude-sdk/claude-sdk-session-manager.ts:112`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/claude-sdk/claude-sdk-session-manager.ts#L112 ) 에서 `this.sessions.set(id, entry)`를 수행한다.

4. 왜 기존 live 실행 거부나 resume dedupe가 없나?
   lazy resume이 **single-flight가 없는 낙관적 재개 분기**로 구현되어 있기 때문이다.

   근거:
   - `discord-app.ts`의 lazy resume은 persisted mapping만 있으면 재개를 시도한다.
   - `ClaudeSdkSessionManager`에는 `resumePromises`, owner lease, generation token 같은 중복 방지 장치가 없다.

5. 왜 lazy resume이 single-flight 없는 낙관적 재개 분기로 구현되었나?
   설계가 "재시작 후 세션 identity 복원"에 초점을 맞췄고, "동시에 누가 그 세션을 소유하는가"라는 **배타적 소유권 문제**를 다루지 않았기 때문이다.

### 근본 원인

**lazy resume이 persisted mapping만 보고 세션을 재개할 뿐, 동일 session/thread의 단일 소유권을 보장하는 상태 머신으로 설계되지 않았다.**

### 대책

- `sessionId` 또는 `threadId` 기준 single-flight resume 락 추가
- `startSession()`에서 동일 `sessionId` live entry가 있으면 재사용 또는 실패
- owner token / generation fencing 도입

## Problem 2

### 문제

Claude가 Bash/Read 도구를 실행 중인데 `!잠깐`은 계속 `No active session to interrupt`를 반환한다.

### 5Why

1. 왜 `!잠깐`이 실패했나?
   인터럽트 처리 코드가 **running 상태의 세션을 찾지 못했기** 때문이다.

   근거:
   - [`src/discord/discord-app.ts:283`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/discord-app.ts#L283 ) 에서 `claudeSdkSessionManager.getSession(claudeSessionId)`를 조회하고, `status === 'running'`일 때만 interrupt 한다.
   - 로그에서는 같은 시각에 도구 호출 메시지가 계속 보이는데도 `No active session to interrupt`가 반환된다.

2. 왜 인터럽트 처리 코드가 running 상태의 세션을 찾지 못했나?
   도구 호출을 실제로 발생시키는 stream과, `!잠깐`을 처리한 프로세스가 조회한 로컬 `sessions` 엔트리가 **서로 다른 실행체**였기 때문이다.

   근거:
   - 도구 호출은 Discord thread로 계속 올라오지만, 인터럽트는 로컬 `claudeSdkSessionManager.sessions`만 본다.
   - 즉 "보이는 활동"과 "현재 프로세스가 추적하는 세션"이 다르면 인터럽트가 실패한다.

3. 왜 도구 호출 stream과 로컬 `sessions` 엔트리가 다른 실행체가 될 수 있나?
   같은 thread/session에 대해 **중복 resume된 다른 stream 또는 다른 프로세스**가 존재할 수 있기 때문이다.

   근거:
   - 문제 1에서 확인했듯 동일 thread에 둘 이상의 turn 1 세션이 존재한 흔적이 있다.
   - `startSession()`은 중복 실행을 차단하지 않는다.

4. 왜 인터럽트는 그 다른 stream 또는 다른 프로세스를 건드리지 못하나?
   인터럽트 기능이 **현재 프로세스 메모리 안의 `sessions` 맵만 제어**하기 때문이다.

   근거:
   - [`src/discord/claude-sdk/claude-sdk-session-manager.ts:158`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/claude-sdk/claude-sdk-session-manager.ts#L158 ) 의 `interruptSession()`은 `this.sessions.get(sessionId)`로 찾은 엔트리에만 `turnAbortController.abort()`와 `activeQuery.interrupt()`를 보낸다.
   - 다른 프로세스에 살아 있는 stream에는 접근할 방법이 없다.

5. 왜 인터럽트 기능이 현재 프로세스 메모리의 `sessions` 맵만 제어하게 되었나?
   런타임 제어 상태가 **프로세스 로컬 메모리 기반**으로 설계되었고, 다중 인스턴스 상황에서 공유되는 authoritative runtime registry가 없기 때문이다.

### 근본 원인

**인터럽트 제어가 프로세스 로컬 세션 맵에만 의존하고, 실제 실행 중인 stream owner와 제어 owner를 일치시키는 공유 런타임 상태가 없다.**

### 대책

- interrupt 대상에 owner token 검증 추가
- 다중 인스턴스에서 공유되는 runtime registry 또는 lease 저장소 도입
- 최소한 동일 session/thread의 resume owner를 기록하고, 그 owner만 interrupt 하도록 보장

## Problem 3

### 문제

두 세션이 동시에 돌아가고 어떤 봇 명령으로도 중단되지 않아 안전장치가 무력화된다.

### 5Why

1. 왜 안전장치가 무력화되었나?
   **제어 plane**과 **실행 plane**이 서로 다른 owner를 바라보게 되었기 때문이다.

   근거:
   - 실행 중인 Claude는 계속 도구를 호출하는데, 제어 명령은 그 실행체를 중단하지 못했다.
   - 즉 "누가 실행 중인가"와 "누가 제어권을 갖고 있는가"가 분리되었다.

2. 왜 제어 plane과 실행 plane이 서로 다른 owner를 바라보게 되었나?
   실행 상태와 제어 상태가 모두 **프로세스 로컬 메모리**에 있고, thread 단위로 하나의 공통 owner를 합의하지 않기 때문이다.

   근거:
   - 실행 세션은 `ClaudeSdkSessionManager.sessions`에 있다.
   - 권한 요청 resolver와 YOLO 상태도 `DiscordState`의 메모리 맵/셋에 있다.
   - 예: [`src/discord/state.ts:69`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/state.ts#L69 ) 의 `pendingPermissions`, [`src/discord/state.ts:75`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/state.ts#L75 ) 의 `yoloSessions`.

3. 왜 thread 단위 공통 owner 합의가 없나?
   persisted layer가 저장하는 것은 thread -> session identity 정도이고, **runtime owner / generation / process identity**를 저장하지 않기 때문이다.

   근거:
   - [`src/discord/session-store.ts`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/session-store.ts ) 의 persisted mapping은 `sessionId`, `threadId`, `channelId`, `cwd`, `sdkSessionId` 중심이다.
   - 현재 owner pid나 instance UUID 같은 실행 소유권 정보는 없다.

4. 왜 runtime owner / generation / process identity를 저장하지 않았나?
   설계가 다중 인스턴스 제어보다 **단일 봇 프로세스 재시작 후 resume**만을 전제로 했기 때문이다.

   근거:
   - PM2 설정은 [`ecosystem.config.cjs`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/ecosystem.config.cjs ) 에서 `script: 'npm'`, `args: 'run discord'`로 되어 있고, 이 자체가 orphan 위험을 만든다.
   - 그런데 코드 레벨에서는 orphan이나 중복 인스턴스를 감지/차단하는 장치가 없다.

5. 왜 단일 봇 프로세스만을 전제로 설계했나?
   이 시스템의 안전장치가 "분산 제어 시스템"이 아니라 "단일 프로세스 내부 상태를 제어하는 봇"으로 출발했기 때문이다.

### 근본 원인

**안전장치 전체가 단일 프로세스 가정 위에 서 있는데, lazy resume + PM2 orphan 가능성 때문에 실제 런타임은 다중 owner 상태가 되었고 이를 막거나 흡수할 분산 제어 설계가 없다.**

### 대책

- PM2를 실제 node 엔트리포인트 직접 실행 방식으로 변경
- bot instance UUID와 session owner를 persisted/shared store에 기록
- permissions, interrupt, yolo 상태를 owner-aware 하게 재설계
- stale owner가 올린 이벤트/버튼/메시지를 fencing으로 무시

## Notes

- 이전 문서의 "`finalizeSession()` 후 살아 있는 queryHandle이 유령 세션이 된다" 설명은 현재 코드만 보면 1순위 원인으로 보기 어렵다.
- 더 직접적인 설명은 "중복 resume된 다른 stream이 살아 있고, 현재 제어 명령은 자기 로컬 메모리만 본다"이다.
- 문제 1은 "중복 생성", 문제 2는 "중복 생성된 실행체를 못 끊는 이유", 문제 3은 "그 결과 왜 안전장치 전체가 죽는지"를 각각 설명한다.
