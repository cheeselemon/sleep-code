# YOLO ↔ Codex sandboxMode 동적 연동 — 구현 보고서

## 빌드 상태: PASS

## 변경 요약

YOLO 모드 토글 시 같은 스레드의 Codex 세션 `sandboxMode`가 동적 전환됨.
- YOLO ON → `workspace-write` (파일 수정, 명령 실행 가능)
- YOLO OFF → `read-only` (기존 동작)

---

## 변경 파일별 상세

### 1. `src/discord/codex/codex-session-manager.ts`

#### 1-1. SandboxMode 타입 import 및 re-export (L9, L12)
```typescript
import type { Thread, SandboxMode } from '@openai/codex-sdk';
export type { SandboxMode } from '@openai/codex-sdk';
```
- SDK에서 `SandboxMode` 타입을 가져와 외부에서도 사용 가능하도록 re-export.

#### 1-2. CodexSessionEntry에 sandboxMode 필드 추가 (L18)
```typescript
sandboxMode: SandboxMode;
```
- 각 세션이 현재 어떤 sandbox 모드인지 추적.

#### 1-3. startSession()에 옵션 파라미터 추가 (L64-78)
```typescript
async startSession(cwd: string, discordThreadId: string, options?: {
  sandboxMode?: SandboxMode;
}): Promise<CodexSessionEntry>
```
- `sandboxMode` 기본값: `'read-only'`
- `startThread()`에 `sandboxMode`와 `approvalPolicy: 'never'` 전달.

#### 1-4. switchSandboxMode() 메서드 추가 (L149-181)
```typescript
async switchSandboxMode(sessionId: string, newMode: SandboxMode): Promise<boolean>
```
- 이미 동일 모드면 skip (early return)
- 진행 중인 turn이 있으면 abort
- `codexThreadId`가 있으면 `resumeThread(id, { sandboxMode, approvalPolicy })` — 대화 히스토리 보존
- `codexThreadId`가 없으면 (첫 turn 전) `startThread()` 재생성
- session map의 `codexThread` 객체만 교체 (sessionId 유지, map 안 깨짐)

#### 1-5. runStreamed에 AbortSignal 전달 (L228)
```typescript
const { events } = await session.codexThread.runStreamed(prompt, {
  signal: abortController.signal,
});
```
- 기존 버그: signal을 넘기지 않아 abort가 SDK 레벨에서 처리되지 않음.
- SDK가 `TurnOptions.signal`을 지원함 (확인 완료).

#### 1-6. restoreSessions에 sandboxMode 기본값 추가 (L208)
- 복원된 세션은 `sandboxMode: 'read-only'`로 시작.

---

### 2. `src/discord/commands/yolo.ts` (경로 1: `/yolo-sleep` 명령)

#### 변경 (L34-60)
- context에서 `codexSessionManager` 추출.
- YOLO ON: `switchSandboxMode(codexSession.id, 'workspace-write')` 호출.
- YOLO OFF: `switchSandboxMode(codexSession.id, 'read-only')` 호출.
- `getSessionByDiscordThread(channelId)`로 같은 스레드의 Codex 세션 탐색.

---

### 3. `src/discord/interactions/panel.ts` (경로 2: Panel YOLO 버튼)

#### 변경 (L32-51)
- context에서 `codexSessionManager` 추출.
- 토글 후 `switchSandboxMode()` 호출.
- `newState ? 'workspace-write' : 'read-only'`로 모드 결정.

---

### 4. `src/discord/interactions/permissions.ts` (경로 3: Permission YOLO 버튼)

#### 변경 (L12, L47-51)
- context에서 `codexSessionManager` 추출.
- `decision === 'yolo'`일 때 `switchSandboxMode(codexSession.id, 'workspace-write')` 호출.
- 참고: `deny` 시에는 Codex 모드 변경 없음 (YOLO가 꺼지는 게 아니므로).

---

### 5. `src/discord/interactions/select-menus.ts` (새 세션 시작 시 YOLO 반영)

#### 변경 (L170, L201-207)
- context에서 `state` 추출.
- `channelManager.getSessionByChannel()`로 같은 스레드의 Claude 세션 ID 조회.
- Claude 세션이 YOLO면 `sandboxMode: 'workspace-write'`로 Codex 세션 시작.

---

### 6. `src/discord/discord-app.ts` (auto-create 경로: `x:` prefix)

#### 변경 (L235-239)
- `x:` prefix로 Codex 세션 자동 생성 시 YOLO 상태 확인.
- `isYolo ? 'workspace-write' : 'read-only'`로 시작.
- 로그에 `sandboxMode` 포함.

---

## 아키텍처 결정 근거

| 결정 | 근거 |
|------|------|
| `workspace-write` 사용 (not `danger-full-access`) | Codex CLI `--full-auto` = `workspace-write`. Codex 리뷰에서 확인. |
| Thread 객체 교체 방식 (not stop/start) | session map 깨짐 방지. Codex 리뷰 권고. |
| `resumeThread` 사용 | 대화 히스토리 보존. SDK 소스에서 확인. |
| AbortSignal 전달 추가 | SDK가 `TurnOptions.signal` 지원. Codex 리뷰에서 발견된 기존 버그. |

## Codex 리뷰 결과

### 리뷰 항목 4건 — 모두 검증 완료

| # | 질문 | Codex 판정 | 조치 |
|---|------|-----------|------|
| 1 | `switchSandboxMode()` race condition | **있음(중요)** | 수정 완료 — `finally`에서 `abortController` 동일성 체크 추가 |
| 2 | `deny` 시 Codex 모드 미변경 | **적절** | 변경 없음 |
| 3 | `restoreSessions` 기본 `read-only` | **적절** | 변경 없음 |
| 4 | auto-create `claudeSessionId === null` 처리 | **적절(안전)** | 변경 없음 |

### Race condition 수정 상세 (항목 1)

**문제**: `processStreamedTurn()`의 `finally` 블록이 항상 `session.activeTurn = null` + `status = 'idle'`을 설정.
`switchSandboxMode()` 직후 새 turn이 시작되면, 이전 turn의 `finally`가 새 turn 상태를 덮어쓸 수 있음.

**수정** (`codex-session-manager.ts` L311-316):
```typescript
// Before (race-prone)
session.activeTurn = null;
if (this.sessions.has(session.id)) {
  session.status = 'idle';

// After (race-safe)
if (session.activeTurn === abortController) {
  session.activeTurn = null;
}
if (this.sessions.has(session.id) && session.activeTurn === null) {
  session.status = 'idle';
```
`finally`에서 현재 turn의 `abortController`가 여전히 active인 경우에만 상태를 리셋.
`switchSandboxMode()`가 `activeTurn`을 `null`로 설정한 뒤 새 turn이 시작되었다면, 이전 `finally`는 상태를 건드리지 않음.

## 최종 빌드 상태: PASS (race condition 수정 후 재빌드 확인)
