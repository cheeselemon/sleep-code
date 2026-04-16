# 멀티에이전트 UX 개선 계획

## 배경
멀티에이전트 채팅 라우팅이 동작하지만, 라우팅 가시성 부족·메시지 포맷 중복·불필요한 핑퐁 문제가 있음.
Gemma4와 2라운드 토론 후 합의된 개선안.

## 의사결정 로그

| # | 안건 | 결정 | 사유 |
|---|------|------|------|
| 1 | 라우팅 도구(`route_to_agent`) 도입 | 기각 | Claude/Codex는 커스텀 도구 주입 불가 → 이중 구조 복잡도만 증가 |
| 2 | LLM 분류 단계로 라우팅 판단 | 기각 | 매 메시지 API 호출 → 비용·레이턴시 비현실적 |
| 3 | 종결 패턴 기반 휴리스틱 필터링 | 채택 | API 호출 없이 정규식만 사용, 최소 룰셋으로 시작 |

---

## 변경 1: 라우팅 시 이모지 Reaction

**목적:** 메시지가 어떤 에이전트에게 라우팅되었는지 시각적으로 표시

**수정 파일:**
- `src/discord/agents/model-registry.ts`
- `src/discord/agent-routing.ts`

**변경 내용:**
1. `ModelDefinition` 인터페이스에 `emoji?: string` 필드 추가
2. 모델별 이모지 할당:
   - gemma4 → 💎
   - glm5 → 🧊
   - glm51 → 🧊
   - qwen3-coder → 🌀
3. Claude/Codex용 기본 이모지 상수 export:
   ```typescript
   export const AGENT_EMOJI: Record<string, string> = {
     claude: '🟣',
     codex: '🟢',
     default: '🤖',
   };
   ```
4. `executeRoute()`에서 `thread.send()` 반환값 저장 → `sentMsg.react(emoji)` 호출
5. 이모지 결정: model-registry alias 조회 → AGENT_EMOJI → default
6. `react()` 호출은 `try-catch`로 감싸서 레이트 리밋 실패 시 로그만 남김

---

## 변경 2: 라우팅 메시지 포맷 단일화

**목적:** 발신자·수신자를 명확하게 표시하고 기존 `sourceLabel:` 중복 제거

**수정 파일:**
- `src/discord/agent-routing.ts`

**변경 내용:**
1. 에이전트에게 전달하는 메시지 포맷 변경:
   - 현재: `${sourceLabel}: ${routeContent}\n\n(Start with @${sourceAgent} to reply)`
   - 변경: `[Route: @${sourceAgent} → @${targetName}]\n${routeContent}\n\n(Start with @${sourceAgent} to reply)`
2. Discord 로그 메시지도 변경: `**${sourceAgent} → ${targetName}** ✉️`
3. 테스트 시 에이전트가 `[Route: ...]` 태그를 답변에 복사하는지 확인
   - 발생 시 시스템 프롬프트에 무시 지침 1줄 추가

---

## 변경 3: 종결 패턴 기반 라우팅 스킵

**목적:** @멘션 없이 "완료했습니다" 같은 답변이 다른 에이전트에게 불필요하게 전달되는 것 방지

**수정 파일:**
- `src/discord/agent-routing.ts`

**변경 내용:**
1. `tryRouteToAgent()`의 라우팅 판단을 3단계로 재구성:
   ```
   1단계: explicit @멘션 → 무조건 라우팅 (기존 로직 유지)
   2단계: explicit: false + bodyMention 없음 → 종결 패턴 검사
          ├─ 매칭 → routed: false 반환 (Discord에 출력)
          └─ 미매칭 → 기존 디폴트 라우팅
   3단계: bodyMention 있음 → 기존 폴백 라우팅
   ```
2. 종결 패턴 정규식 (content.trimEnd() 후 적용):
   ```typescript
   const TERMINAL_PATTERN = /(?:완료|종료|마칩니다|마쳤습니다|끝났습니다|보고드립니다|done|finished|completed)\s*[.!]?\s*$/i;
   ```
3. 코드블록 외부 텍스트만 검사

---

## 구현 순서

1. 변경 1 (이모지) → 빌드 확인
2. 변경 2 (포맷) → 빌드 확인
3. 변경 3 (종결 패턴) → 빌드 확인
4. Discord에서 멀티에이전트 라우팅 통합 테스트

## 변경하지 않는 파일
- `src/discord/utils.ts` — `parseRoutingDirective` 수정 불필요 (이미 `explicit` 플래그 제공)
- `src/discord/agents/agent-handlers.ts` — `resolveTarget` 로직 변경 없음
- `src/discord/discord-app.ts` — 사용자→에이전트 라우팅은 별도 이슈
