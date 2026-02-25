# Discord Safe Refactoring Plan

## Context
Codex와 합의한 3가지 안전한 리팩토링. 동작 변경 없이 코드 중복 제거 + API 정리만 수행.
완료 후 `docs/plans/discord-safe-refactor-plan.md`에도 복사.

---

## 1. ChannelManager API 정리 — `getChannel()` 제거

### 현황
`channel-manager.ts:492-499`에 `getSession()`과 `getChannel()`이 100% 동일 구현:
```typescript
getSession(sessionId: string): ChannelMapping | undefined {
  return this.sessions.get(sessionId);
}
// Alias for compatibility
getChannel(sessionId: string): ChannelMapping | undefined {
  return this.sessions.get(sessionId);
}
```

### 방향
Discord `getChannel()` 제거, 호출을 `getSession()`으로 통일.
Slack도 일관성을 위해 `getChannel()` → `getSession()` rename.

### 영향 파일 및 변경 내역

**Discord (같은 클래스, alias 제거):**

| 파일 | 변경 |
|------|------|
| `src/discord/channel-manager.ts` | `getChannel()` 메서드 삭제 |
| `src/discord/commands/controls.ts:21` | `getChannel` → `getSession` |
| `src/discord/commands/yolo.ts:26` | `getChannel` → `getSession` |

**Slack (별도 클래스, rename):**

| 파일 | 변경 |
|------|------|
| `src/slack/channel-manager.ts:151` | `getChannel()` → `getSession()` rename |
| `src/slack/slack-app.ts` (10곳) | `getChannel` → `getSession` |

### 주의
- Slack의 `ChannelManager`(`src/slack/channel-manager.ts`)는 Discord와 **별도 클래스**. `getChannel()`만 존재하므로 `getSession()`으로 rename.
- 두 클래스의 API 이름을 통일하여 혼동 방지.

---

## 2. `getSessionFromChannel()` 공통 헬퍼 추출

### 현황
`controls.ts:10-27`과 `yolo.ts:15-32`에 **완전 동일한** 함수가 복사됨:
```typescript
function getSessionFromChannel(
  channelId: string,
  context: Parameters<CommandHandler>[1]
): { sessionId: string } | { error: string } {
  const { channelManager } = context;
  const sessionId = channelManager.getSessionByChannel(channelId);
  if (!sessionId) return { error: 'This channel is not associated with an active session.' };
  const channel = channelManager.getChannel(sessionId);  // → getSession으로 변경
  if (!channel || channel.status === 'ended') return { error: 'This session has ended.' };
  return { sessionId };
}
```

### 방향
`src/discord/commands/helpers.ts` 신규 생성, 공통 함수 1개로 추출.

### 영향 파일

| 파일 | 변경 |
|------|------|
| `src/discord/commands/helpers.ts` (신규) | `getSessionFromChannel()` 정의 |
| `src/discord/commands/controls.ts` | 로컬 함수 삭제, import 추가 |
| `src/discord/commands/yolo.ts` | 로컬 함수 삭제, import 추가 |

### 사용처 (변경 불필요, 호출 시그니처 동일)
- `handleBackground`, `handleInterrupt`, `handleMode`, `handleCompact`, `handleModel` (controls.ts)
- `handleYoloSleep`, `handlePanel` (yolo.ts)

---

## 3. 에이전트 라우팅 공통 유틸 추출

### 현황
`handlers/message.ts:68-117`(Claude→Codex)와 `codex/codex-handlers.ts:100-151`(Codex→Claude)에 ~50줄 거의 동일한 라우팅 로직:

공통 흐름:
1. `parseRoutingDirective()` 호출
2. `shouldRoute` 판정 (explicit || bodyMention fallback)
3. `MAX_AGENT_ROUTING` 제한 체크
4. 라우팅 카운터 증가
5. Discord echo 메시지 전송 (`**Label:** content`)
6. 대상 에이전트에 입력 전달
7. 실패 시 경고 메시지
8. `lastActiveAgent` 업데이트

### 차이점 (유틸에서 추상화)
| 항목 | Claude→Codex | Codex→Claude |
|------|-------------|-------------|
| 세션 검증 | `codexSession.status !== 'ended'` | `sessionManager != null` |
| 메시지 중복방지 | 없음 | `discordSentMessages.add()` |
| sendInput | `await codexSessionManager.sendInput()` | `sessionManager.sendInput()` (sync) |
| 라벨 | `Claude → Codex` | `Codex → Claude` |

### 방향
`src/discord/utils/agent-routing.ts` 신규 생성:

```typescript
interface RouteParams {
  thread: AnyThreadChannel;
  content: string;        // 원본 텍스트
  cleanContent: string;   // 클린 텍스트 (explicit routing용)
  agents: { claude?: string; codex?: string };
  sourceAgent: 'claude' | 'codex';
  state: DiscordState;
  sendToTarget: (content: string) => Promise<boolean> | boolean;
  onBeforeSend?: (content: string) => void;  // discordSentMessages.add 등
}

interface RouteResult {
  routed: boolean;  // true면 caller에서 return (skip normal display)
}

export function tryRouteToAgent(params: RouteParams): Promise<RouteResult>
```

- `sendToTarget` 콜백으로 Claude/Codex 전송 차이를 추상화
- `onBeforeSend` 콜백으로 메시지 중복방지 처리

### 영향 파일

| 파일 | 변경 |
|------|------|
| `src/discord/utils/agent-routing.ts` (신규) | `tryRouteToAgent()` 정의 |
| `src/discord/handlers/message.ts` | ~50줄 → `tryRouteToAgent()` 호출 ~10줄 |
| `src/discord/codex/codex-handlers.ts` | ~50줄 → `tryRouteToAgent()` 호출 ~10줄 |

---

## 실행 순서

1. **Step 1**: `getSessionFromChannel` 헬퍼 추출 (가장 간단, 위험도 최저)
2. **Step 2**: `getChannel()` → `getSession()` 통일 (단순 rename, 범위 넓음)
3. **Step 3**: 에이전트 라우팅 유틸 추출 (가장 복잡, 마지막에 수행)

각 단계마다 `npm run build` 통과 확인.

## 수용 기준

1. `npm run build` 성공 (타입 에러 없음)
2. 기존 동작 100% 불변 — 새 기능/로직 변경 없음
3. 중복 코드 제거: `getSessionFromChannel` 2→1, `getChannel` 제거, 라우팅 ~100줄→~50줄
4. 각 단계별 개별 커밋 가능

## Verification

```bash
npm run build            # 타입 체크 + 빌드
pm2 restart sleep-discord
```
Discord에서 기존 기능 테스트:
- `/interrupt`, `/background`, `/mode` 등 controls 명령
- `/yolo-sleep`, `/panel`
- Claude ↔ Codex 라우팅 (@codex, @claude)
- `/status`
