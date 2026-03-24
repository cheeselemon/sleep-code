# Lazy Resume Minimal Fix Proposal

## Goal

`docs/plans/lazy-resume-5why-reply.md`의 대책 중에서, **현재 단일 프로세스 구조를 유지한 채 최소한의 변경으로**

- 문제 1: 세션 이중 생성
- 문제 2: 인터럽트 불가

를 막는 구체적 구현 방안을 정리합니다.

핵심 원칙:

- 분산 런타임 레지스트리, 외부 락 저장소 같은 큰 설계는 하지 않는다.
- 대신 **PM2 orphan 차단 + 단일 프로세스 내 중복 resume 방지 + interrupt fallback**만 넣는다.

## 결론

최소 수정안은 아래 3개입니다.

1. `ecosystem.config.cjs`에서 PM2가 `npm`이 아니라 실제 Node 엔트리포인트를 직접 실행하게 바꾼다.
2. `src/discord/discord-app.ts`에 **lazy resume single-flight helper**를 추가한다.
3. `src/discord/claude-sdk/claude-sdk-session-manager.ts`와 `src/discord/discord-app.ts`에 **중복 start 방어 + thread 기준 interrupt fallback**을 추가한다.

이 3개면 현재 보고된 증상 대부분을 실용적으로 막을 수 있습니다.

## Why This Is Enough

문제의 실제 트리거는 두 층입니다.

- 운영 층: PM2가 orphan 프로세스를 남길 수 있다.
- 코드 층: lazy resume이 같은 thread/session에 대해 중복 `startSession()`을 허용한다.

따라서:

- orphan를 끊으면 "두 프로세스가 동시에 같은 Discord 이벤트 처리"가 사라지고
- single-flight를 넣으면 "한 프로세스 안에서 같은 세션 두 번 resume"도 사라진다.

이 상태에서는 interrupt는 다시 단일 프로세스의 live session 하나만 보면 되므로, 간단한 thread fallback만 넣어도 충분하다.

## Change 1: PM2 Config

### File

- [`ecosystem.config.cjs`](/Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/ecosystem.config.cjs)

### Current

```js
{
  name: 'sleep-discord',
  script: 'npm',
  args: 'run discord',
  cwd: __dirname,
}
```

### Proposed

```js
{
  name: 'sleep-discord',
  script: 'dist/cli/index.js',
  args: 'discord',
  interpreter: 'node',
  cwd: __dirname,
}
```

### Why

- PM2가 `npm` 부모가 아니라 실제 long-lived node 프로세스를 직접 관리해야 orphan 위험이 크게 줄어든다.
- 이 변경 없이는, 코드에서 아무리 single-flight를 넣어도 "다른 orphan 프로세스가 살아 있는 경우"의 interrupt 실패를 완전히 막을 수 없다.

### Scope

- 최소 범위로는 `sleep-discord`만 바꿔도 된다.
- 정리 차원에서는 `sleep-slack`, `sleep-telegram`도 같은 방식으로 맞추는 편이 낫다.

## Change 2: Lazy Resume Single-Flight

### Files

- [`src/discord/discord-app.ts`](/Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/discord-app.ts)

### Problem In Current Code

현재 lazy resume 분기:

- `getSession(effectiveClaudeSessionId)` 조회
- 없으면 persisted mapping 찾기
- 바로 `startSession(...)`

이 흐름에는 "같은 session/thread resume이 이미 진행 중인지"를 막는 장치가 없다.

### Proposed Shape

`createDiscordApp()` 스코프 안에 아래 맵을 하나 둔다.

```ts
const pendingLazyResumes = new Map<string, Promise<ClaudeSdkSessionEntry | null>>();
```

키는 `sessionId`를 권장한다.

### Helper

`discord-app.ts` 안에 작은 헬퍼를 추가한다.

```ts
async function ensureClaudeSdkSession(
  sessionId: string,
  threadId: string,
): Promise<ClaudeSdkSessionEntry | null> {
  const existingById = claudeSdkSessionManager.getSession(sessionId);
  if (existingById && existingById.status !== 'ended') {
    return existingById;
  }

  const existingByThread = claudeSdkSessionManager.getSessionByThread(threadId);
  if (existingByThread && existingByThread.status !== 'ended') {
    return existingByThread;
  }

  const pending = pendingLazyResumes.get(sessionId);
  if (pending) {
    return pending;
  }

  const promise = (async () => {
    const recheckById = claudeSdkSessionManager.getSession(sessionId);
    if (recheckById && recheckById.status !== 'ended') {
      return recheckById;
    }

    const recheckByThread = claudeSdkSessionManager.getSessionByThread(threadId);
    if (recheckByThread && recheckByThread.status !== 'ended') {
      return recheckByThread;
    }

    const persisted = channelManager
      .getPersistedSdkMappings()
      .find(m => m.sessionId === sessionId);

    if (!persisted) {
      return null;
    }

    const canResume = persisted.sdkSessionId && persisted.sdkSessionId !== persisted.sessionId;

    const entry = canResume
      ? await claudeSdkSessionManager.startSession(persisted.cwd, persisted.threadId!, {
          sessionId: persisted.sessionId,
          resume: persisted.sdkSessionId,
        })
      : await claudeSdkSessionManager.startSession(persisted.cwd, persisted.threadId!, {
          sessionId: persisted.sessionId,
        });

    channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);
    return entry;
  })().finally(() => {
    pendingLazyResumes.delete(sessionId);
  });

  pendingLazyResumes.set(sessionId, promise);
  return promise;
}
```

### Call Site Change

현재 [`src/discord/discord-app.ts:410`]( /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/discord-app.ts#L410 ) 부근의 lazy resume 분기를:

- 직접 `startSession()` 하는 코드

에서

- `sdkSession = await ensureClaudeSdkSession(effectiveClaudeSessionId, threadId)`

로 바꾼다.

### Why This Fixes Problem 1

- 같은 sessionId에 대한 lazy resume가 동시에 들어와도, 첫 번째 Promise만 실제 `startSession()`을 실행한다.
- 나머지 호출은 그 Promise를 await하므로 **한 프로세스 안에서 중복 SDK stream 생성이 사라진다**.

## Change 3: Session Manager Guard

### Files

- [`src/discord/claude-sdk/claude-sdk-session-manager.ts`](/Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/claude-sdk/claude-sdk-session-manager.ts)

### Problem In Current Code

`startSession()`은 동일 `sessionId`나 동일 `threadId`의 live session이 있어도 무조건 새 `entry`를 만든다.

이건 caller가 실수해도 manager가 막아주지 못한다는 뜻이다.

### Minimal Guard

`startSession()` 맨 앞에 아래 방어를 넣는다.

```ts
const id = options?.sessionId ?? randomUUID();

const existing = this.sessions.get(id);
if (existing && existing.status !== 'ended') {
  log.warn({ sessionId: id }, 'Reusing existing Claude SDK session');
  return existing;
}

const existingByThread = this.getSessionByThread(discordThreadId);
if (existingByThread && existingByThread.status !== 'ended') {
  log.warn({ sessionId: existingByThread.id, discordThreadId }, 'Reusing existing Claude SDK session for thread');
  return existingByThread;
}

const entry = this.createEntry(id, cwd, discordThreadId);
```

### Why

- `discord-app.ts`에서 single-flight를 넣더라도, manager 레벨 guard가 있으면 방어선이 하나 더 생긴다.
- "호출부가 다시 실수하면 또 복제"를 막는 최소 비용 안전장치다.

## Change 4: Interrupt Fallback By Thread

### Files

- [`src/discord/discord-app.ts`](/Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/discord-app.ts)

### Problem In Current Code

현재 interrupt는:

```ts
const sdkSession = claudeSdkSessionManager.getSession(claudeSessionId);
if (sdkSession && sdkSession.status === 'running') {
  claudeSdkSessionManager.interruptSession(claudeSessionId);
}
```

즉, `claudeSessionId` 기준 단일 조회만 한다.

### Proposed

조회 순서를 두 단계로 바꾼다.

```ts
let sdkSession = claudeSessionId
  ? claudeSdkSessionManager.getSession(claudeSessionId)
  : undefined;

if ((!sdkSession || sdkSession.status !== 'running') && threadId) {
  sdkSession = claudeSdkSessionManager.getSessionByThread(threadId);
}

if (sdkSession && sdkSession.status === 'running') {
  claudeSdkSessionManager.interruptSession(sdkSession.id);
  interrupted = true;
}
```

### Why This Helps

- `channelManager.getAgentsInThread()`가 주는 `claudeSessionId`가 stale하거나,
- lazy resume 직후 thread 쪽 live entry를 다시 잡아야 하는 경우

에도 thread 기준으로 한 번 더 찾을 수 있다.

이건 문제 2를 "완전한 분산 제어" 없이 완화하는 가장 싼 수정이다.

## Optional Small Improvement

### File

- [`src/discord/discord-app.ts`](/Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/discord-app.ts)

### Proposal

interrupt 실패 시 디버그 로그를 추가한다.

```ts
log.warn({
  threadId,
  claudeSessionId,
  byIdStatus: byId?.status,
  byThreadId: byThread?.id,
  byThreadStatus: byThread?.status,
  pid: process.pid,
}, 'Interrupt requested but no running Claude SDK session found');
```

### Why

- 만약 재발하면, "정말 single-process race였는지 / 아직 PM2 orphan가 남았는지"를 바로 알 수 있다.
- 기능 변경 없이 진단력만 높인다.

## What I Would Not Do Yet

지금 단계에서는 아래는 하지 않는 편이 맞다.

- 외부 저장소 기반 distributed lock
- 분산 runtime registry
- permission state 전체의 persistent/shared store화
- owner token/generation을 모든 이벤트에 강제 적용하는 대규모 refactor

이건 현재 문제를 해결하는 데 비해 변경 폭이 너무 크다.

## Implementation Order

1. `ecosystem.config.cjs` 수정
2. `claude-sdk-session-manager.ts`에 `startSession()` guard 추가
3. `discord-app.ts`에 `pendingLazyResumes` + `ensureClaudeSdkSession()` 추가
4. `discord-app.ts` interrupt fallback 추가
5. 재발 확인용 로그 추가

## Expected Outcome

이 변경 후 기대 결과:

- 재시작 후 같은 session/thread가 한 프로세스 안에서 두 번 resume되지 않는다.
- PM2가 orphan 프로세스를 남겨서 "이전 프로세스 + 새 프로세스"가 동시에 Discord를 듣는 상황이 크게 줄어든다.
- `!잠깐`은 최소한 현재 프로세스의 live Claude SDK session을 thread 기준으로 한 번 더 찾아서 끊을 수 있다.

## Residual Risk

만약 이미 orphan 프로세스가 남아 있는 상태에서 새 코드만 배포하면, 그 orphan를 직접 죽이기 전까지는 여전히 이상 증상이 남을 수 있다.

즉, **코드 변경과 PM2 실행 방식 수정은 같이 들어가야 한다.**
