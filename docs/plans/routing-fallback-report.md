# Agent-to-Agent Routing Fallback — Implementation Report

## Problem
`parseRoutingDirective`가 `^@codex`/`^@claude` 첫 토큰만 인식하여, LLM이 맥락을 먼저 쓰고 멘션을 뒤에 넣으면 라우팅이 조용히 실패함. 사용자가 수동 개입 필요.

## Changes (3 files)

### 1. `src/discord/utils.ts` — Parser 개선

**Added:**
- `normalizeInvisible()` (line ~136): BOM(`\uFEFF`), zero-width chars(`\u200B-\u2060`) 제거
- `extractBodyMentionTarget()` (line ~152): 코드블록 제외 후 본문에서 `@codex`/`@claude` 대상 추출
- `RoutingDirective.bodyMentionTarget?: AgentType` 필드 추가

**Modified:**
- `parseRoutingDirective()`:
  - `content.trimStart()` → `normalizeInvisible(content).trimStart()`
  - 정규식 `^@codex[:\s]*/i` → `^@codex\b[:\s]*/i` (`\b` word boundary로 `@codextra` 오탐 방지)
  - `hasBodyMention()` → `extractBodyMentionTarget()` 전환, 결과에 `bodyMentionTarget` 포함

### 2. `src/discord/handlers/message.ts` — Claude→Codex fallback

**Before:** `if (explicit && target === 'codex')`만 라우팅
**After:**
```ts
const shouldRoute =
  (explicit && target === 'codex') ||
  (!explicit && invalidMention && bodyMentionTarget === 'codex');
```
- fallback 시 `routeContent = formatted` (원본 전체, 멘션 strip 안 함)
- 라우팅 라벨: explicit → `Claude → Codex`, fallback → `Claude → Codex ✉️`
- Codex 세션 불가 시 `⚠️` 경고 에코 추가 (기존: 조용히 fallthrough)

### 3. `src/discord/codex/codex-handlers.ts` — Codex→Claude fallback

message.ts와 동일 패턴, 방향만 반대:
```ts
const shouldRoute =
  (explicit && target === 'claude') ||
  (!explicit && invalidMention && bodyMentionTarget === 'claude');
```
- fallback 라벨: `Codex → Claude ✉️`
- Claude 세션 불가 시 `⚠️` 경고 에코 추가

## Not Changed
- `src/discord/discord-app.ts` — 사용자 메시지 라우팅 기존 동작 유지 (invalidMention 💡 경고만)
- `src/discord/state.ts` — `MAX_AGENT_ROUTING` 등 기존 상태 그대로

## Edge Cases

| 시나리오 | Before | After |
|---------|--------|-------|
| `@codex review this` (첫 토큰) | ✅ 라우팅 | ✅ 라우팅 (explicit) |
| `분석 끝. @codex 확인해줘` (중간) | ❌ 조용히 실패 | ✅ 라우팅 (fallback) |
| `\uFEFF@codex ...` (BOM) | ❌ 조용히 실패 | ✅ 라우팅 (정규화) |
| `@codextra something` | ⚠️ 잘못된 매칭 | ✅ 매칭 안 됨 (\b) |
| 코드블록 내 `` `@codex` `` | ✅ 무시 | ✅ 무시 |
| 대상 세션 종료 | ❌ 조용히 fallthrough | ✅ 경고 에코 |

## Build
```
ESM dist/cli/index.js 245.86 KB
ESM ⚡️ Build success in 32ms
```

## Review Checklist
- [ ] `shouldRoute` 조건이 기존 explicit 라우팅을 깨뜨리지 않는가?
- [ ] fallback 시 원본 전체(`formatted`/`content`)를 보내는 것이 적절한가? (멘션 strip 없이)
- [ ] `bodyMentionTarget`이 양쪽 에이전트 다 감지할 경우 첫 번째 매칭만 사용 — 문제 없는가?
- [ ] `hasBodyMention()` 함수가 이제 미사용 — 제거할지 유지할지?
- [ ] 사용자 메시지에는 fallback 적용 안 함 — 의도대로인가?
