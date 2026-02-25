# Discord Safe Refactoring — Review Request

## 변경 요약

3가지 리팩토링 완료. 동작 변경 없음, `npm run build` 통과.

### 1. `getSessionFromChannel` 헬퍼 추출
- `src/discord/commands/helpers.ts` (신규) — 공통 함수 정의
- `src/discord/commands/controls.ts` — 로컬 함수 삭제, import 추가
- `src/discord/commands/yolo.ts` — 로컬 함수 삭제, import 추가

### 2. `getChannel()` → `getSession()` 통일
- `src/discord/channel-manager.ts` — `getChannel()` alias 삭제
- `src/slack/channel-manager.ts` — `getChannel()` → `getSession()` rename
- `src/slack/slack-app.ts` — 10곳 rename
- `src/discord/discord-app.ts` — 2곳 rename

### 3. 에이전트 라우팅 공통 유틸 추출
- `src/discord/agent-routing.ts` (신규) — `tryRouteToAgent()` 정의
- `src/discord/handlers/message.ts` — ~50줄 → ~10줄
- `src/discord/codex/codex-handlers.ts` — ~50줄 → ~10줄

## 리뷰 포인트

1. `agent-routing.ts`의 `shouldRoute` 로직이 원본과 동치한가?
2. `sendToTarget` / `isTargetAvailable` / `onBeforeSend` 콜백 패턴이 원본 차이점을 정확히 캡처하는가?
3. Codex→Claude 라우팅의 `discordSentMessages.add()` 가 `onBeforeSend`로 정확히 보존되는가?
4. `getSession()` rename이 Slack/Discord 양쪽에서 누락 없이 완료되었는가?
5. 기타 edge case 누락 여부
