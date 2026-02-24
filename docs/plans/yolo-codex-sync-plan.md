# YOLO ↔ Codex sandboxMode 동적 연동 계획

> Claude ↔ Codex 토론 후 합의된 최종 계획

## 목표

Discord에서 YOLO 모드를 토글하면 같은 스레드의 Codex 세션 `sandboxMode`가 동적으로 전환되어
Codex가 파일 수정/명령 실행 권한을 얻거나 잃도록 한다.

## 현재 상태 (문제)

`src/discord/codex/codex-session-manager.ts:54-58`:
```typescript
this.codex = new Codex({
  config: { approval_policy: 'never' }
});
// startThread() 시 sandboxMode 미지정 → 기본값 read-only
```

결과: Codex가 파일 수정, 쓰기 명령 실행 불가.

## SDK 검증 결과 (Claude 분석 + Codex 소스 검증)

| 항목 | 결과 |
|------|------|
| `resumeThread`에 새 `sandboxMode` 반영 | O — CLI에 `--sandbox` 인자로 전달됨 |
| `ThreadOptions`가 global config 덮어쓰기 | O — thread 옵션이 나중에 적용되어 우선 |
| `resumeThread` 시 대화 컨텍스트 보존 | O — `~/.codex/sessions` 기반, 완료된 turn 유지 |
| abort된 turn 결과 | 누락 가능 — 마지막 커밋된 turn 기준으로 재개 |
| YOLO에 적합한 sandboxMode | `workspace-write` (CLI `--full-auto` 동일) |

## 최종 계획

### Step 1: `runStreamed`에 AbortSignal 전달 (버그 수정)

현재 `processStreamedTurn`이 `signal`을 넘기지 않아 abort가 불안정함.

**파일**: `src/discord/codex/codex-session-manager.ts`
```typescript
// Before
const { events } = await session.codexThread.runStreamed(prompt);

// After
const { events } = await session.codexThread.runStreamed(prompt, {
  signal: abortController.signal,
});
```

### Step 2: `CodexSessionManager`에 sandboxMode 지원 추가

**파일**: `src/discord/codex/codex-session-manager.ts`

1. `CodexSessionEntry`에 `sandboxMode` 필드 추가
2. `startSession()`에 `sandboxMode` 옵션 추가:
```typescript
async startSession(cwd: string, discordThreadId: string, options?: {
  sandboxMode?: 'read-only' | 'workspace-write';
})
```
3. `startThread()` 호출 시 전달:
```typescript
const codexThread = this.codex.startThread({
  workingDirectory: cwd,
  sandboxMode: options?.sandboxMode ?? 'read-only',
  approvalPolicy: 'never',
});
```
4. 새 메서드 `switchSandboxMode(sessionId, newMode)` 추가:
   - 진행 중인 turn이 있으면 abort
   - `codexThreadId`가 있으면 `resumeThread(id, { sandboxMode, approvalPolicy: 'never' })`
   - `codexThreadId`가 없으면 (첫 turn 전) `startThread()`로 재생성
   - session map의 `codexThread` 객체만 교체 (sessionId 유지, map 깨짐 방지)

### Step 3: YOLO 토글 시 Codex 연동 (3개 경로)

YOLO 토글이 발생하는 3곳 모두에 동일 로직 추가:

**경로 1**: `/yolo-sleep` 명령 — `src/discord/commands/yolo.ts`
**경로 2**: Panel YOLO 버튼 — `src/discord/interactions/panel.ts`
**경로 3**: Permission YOLO 버튼 — `src/discord/interactions/permissions.ts`

각 경로에서 YOLO 토글 후:
```typescript
// Codex 세션이 같은 스레드에 있으면 sandboxMode 전환
const codexSession = codexSessionManager?.getSessionByDiscordThread(threadId);
if (codexSession) {
  const newMode = isYolo ? 'workspace-write' : 'read-only';
  await codexSessionManager.switchSandboxMode(codexSession.id, newMode);
}
```

### Step 4: 새 Codex 세션 시작 시 YOLO 상태 반영

Codex 세션 생성 시 (select menu handler 등) 해당 스레드의 Claude 세션이 이미 YOLO면:
```typescript
const claudeSessionId = channelManager.getSessionByChannel(threadId);
const isYolo = claudeSessionId && state.yoloSessions.has(claudeSessionId);
await codexSessionManager.startSession(cwd, threadId, {
  sandboxMode: isYolo ? 'workspace-write' : 'read-only',
});
```

## 수정 대상 파일

| 파일 | 변경 내용 |
|------|-----------|
| `src/discord/codex/codex-session-manager.ts` | sandboxMode 필드, switchSandboxMode 메서드, runStreamed signal 전달 |
| `src/discord/commands/yolo.ts` | YOLO 토글 시 Codex sandboxMode 전환 |
| `src/discord/interactions/panel.ts` | YOLO 버튼에 Codex sandboxMode 전환 |
| `src/discord/interactions/permissions.ts` | perm YOLO 버튼에 Codex sandboxMode 전환 |
| `src/discord/interactions/select-menus.ts` | Codex 세션 생성 시 YOLO 상태 반영 |

## 주의사항

- `danger-full-access`는 사용하지 않음 — `workspace-write`가 Codex full-auto와 동일
- session map(`this.sessions`)을 깨지 않도록 `codexThread` 객체만 교체
- abort된 turn은 누락될 수 있으나, idle 상태에서 토글하면 안전
- YOLO OFF 시 진행 중인 쓰기 작업이 있으면 abort 후 read-only로 전환
