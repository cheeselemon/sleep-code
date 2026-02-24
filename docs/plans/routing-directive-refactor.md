# Plan: Routing Directive Refactor

## Goal

`parseAgentPrefix`를 `parseRoutingDirective`로 확장하여, 명시적 prefix 여부(`explicit`)와 본문 중간 멘션 감지(`invalidMention`)를 반환하게 한다. 호출부 3곳에서 `explicit === true`일 때만 에이전트 간 라우팅을 수행하도록 강제한다.

## Problem

현재 `parseAgentPrefix`는 target과 cleanContent만 반환하므로:
- "prefix 없이 기본 라우팅"과 "명시적 @codex 라우팅"을 구분할 수 없음
- 본문 중간/마크다운 내부의 `@codex`/`@claude` 멘션이 라우팅을 오발시킬 수 있음
- legacy prefix(`x:`, `c:`)가 의도치 않은 라우팅을 유발할 수 있음

## Scope

| 파일 | 변경 내용 |
|------|-----------|
| `src/discord/utils.ts` | `parseAgentPrefix` → `parseRoutingDirective` 확장 |
| `src/discord/handlers/message.ts` | `explicit` 체크 추가 |
| `src/discord/codex/codex-handlers.ts` | `explicit` 체크 추가 |
| `src/discord/discord-app.ts` | `invalidMention` 경고 메시지 추가 |

## Step-by-step Tasks

### Task 1: `parseRoutingDirective` 함수 작성 (`src/discord/utils.ts`)

기존 `parseAgentPrefix` 함수를 확장 (기존 이름은 deprecated alias로 유지 가능).

**새 반환 타입:**
```ts
export interface RoutingDirective {
  target: AgentType;
  cleanContent: string;
  explicit: boolean;         // true = 첫 토큰이 @codex/@claude/@mention prefix
  invalidMention: boolean;   // true = 본문 중간에 @codex/@claude 감지됨
}
```

**로직:**
1. `trimmed`의 첫 토큰이 `@codex`/`@claude`면 → `explicit: true`
2. legacy prefix(`x:`, `c:`, `codex:`, `claude:`)도 → `explicit: true` (하위호환)
3. 위에 해당 안 되면 → `explicit: false`, 기존 기본 라우팅 로직 유지
4. `explicit: false`일 때, 본문 어딘가에 `@codex`/`@claude`가 있으면 → `invalidMention: true`
5. `invalidMention` 체크 시 코드블록(`` ` ``/` ``` `) 내부는 제외

**기존 `parseAgentPrefix` 호환:**
```ts
// deprecated alias
export function parseAgentPrefix(...) {
  const result = parseRoutingDirective(...);
  return { target: result.target, cleanContent: result.cleanContent };
}
```

또는 호출부를 모두 `parseRoutingDirective`로 변경 (권장).

### Task 2: `message.ts` 수정 — Claude→Codex 라우팅에 `explicit` 강제

파일: `src/discord/handlers/message.ts` (현재 line 67-97)

**변경:**
```ts
// Before
const { target, cleanContent } = parseAgentPrefix(formatted, { ... });
if (target === 'codex' && agents.codex && cleanContent.trim()) {

// After
const { target, cleanContent, explicit } = parseRoutingDirective(formatted, { ... });
if (explicit && target === 'codex' && agents.codex && cleanContent.trim()) {
```

- `explicit === false`면 라우팅 건너뛰고 일반 Claude 메시지로 표시
- import도 `parseAgentPrefix` → `parseRoutingDirective`로 변경

### Task 3: `codex-handlers.ts` 수정 — Codex→Claude 라우팅에 `explicit` 강제

파일: `src/discord/codex/codex-handlers.ts` (현재 line 99-128)

**변경:**
```ts
// Before
const { target, cleanContent } = parseAgentPrefix(content, { ... });
if (target === 'claude' && agents.claude && cleanContent.trim()) {

// After
const { target, cleanContent, explicit } = parseRoutingDirective(content, { ... });
if (explicit && target === 'claude' && agents.claude && cleanContent.trim()) {
```

- import도 변경

### Task 4: `discord-app.ts` 수정 — `invalidMention` 경고

파일: `src/discord/discord-app.ts`

CEO 입력 라우팅 부분에서 `invalidMention === true`일 때 경고 답장 추가:

```ts
const directive = parseRoutingDirective(inputText, {
  hasClaude: !!claudeSessionId,
  hasCodex: !!codexSessionId,
  lastActive: state.lastActiveAgent.get(threadId),
});

if (directive.invalidMention) {
  await message.reply('💡 `@codex`/`@claude` must be the **first word** of your message to route it. Your message was sent to the default agent.');
}
```

### Task 5: 시스템 안내 메시지 업데이트

`discord-app.ts`의 시스템 안내 문구(line 235, 249)에 규칙 명시:

```
"@mention must be the very first word of your message."
```

## Acceptance Criteria

- [ ] `parseRoutingDirective`가 `explicit`, `invalidMention` 필드를 정확히 반환
- [ ] `@codex hello` → `{ target: 'codex', explicit: true, invalidMention: false }`
- [ ] `hello @codex` → `{ target: 기본값, explicit: false, invalidMention: true }`
- [ ] `` `@codex` in code block `` → `{ explicit: false, invalidMention: false }` (코드블록 무시)
- [ ] Claude→Codex 라우팅: `explicit === true`일 때만 전달
- [ ] Codex→Claude 라우팅: `explicit === true`일 때만 전달
- [ ] CEO가 본문 중간에 멘션 넣으면 경고 메시지 표시
- [ ] `npm run build` 성공
- [ ] legacy prefix(`x:`, `codex:`, `c:`, `claude:`)는 여전히 동작 (`explicit: true`)
