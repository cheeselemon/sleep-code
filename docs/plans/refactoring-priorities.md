# Sleep Code 리팩토링 우선순위

> 2026-03-23 작성 | Claude + Codex 공동 분석 및 리뷰

전체 코드베이스(74개 TypeScript 파일, 16,621줄) 분석 결과입니다.

---

## CRITICAL — 즉시 개선

### 1. channel-manager.ts (1,074줄)

**위치:** `src/discord/channel-manager.ts`

**현재 문제:**
이 파일 하나가 PTY 세션, Codex 세션, Claude SDK 세션의 매핑·저장·복구를 전부 담당합니다.
세 종류의 세션이 거의 같은 패턴(thread 매핑, persist, load, archive)을 반복하는데,
각각 별도의 Map과 별도의 save/load 메서드로 구현되어 있어서 코드가 3벌입니다.

**구체적으로:**
- `threadToSession` / `threadToCodexSession` / `threadToSdkSession` — 3개의 Map
- `saveMappings()` / `saveCodexMappings()` / `saveSdkMappings()` — 3개의 저장 메서드
- `loadMappings()` / `loadCodexMappings()` / `loadSdkMappings()` — 3개의 로딩 메서드
- 각 세션 타입별 create/get/archive 메서드도 3벌

**개선 방향:**
composition 패턴으로 분리하거나, 제네릭 SessionStore를 만들어 공통 로직을 추출합니다.

**리스크:**
높음. PTY/Codex/SDK의 persistence 필드가 미묘하게 다릅니다.
SDK는 `sdkSessionId`가 별도로 있고, Codex는 `codexThreadId`가 있습니다.
과도한 추상화로 이 차이를 뭉개면 오히려 버그가 늘어납니다.
분리할 때 각 타입의 고유 필드를 명시적으로 유지해야 합니다.

---

### 2. ask-question.ts + sdk-ask-question.ts (총 463줄)

**위치:**
- `src/discord/interactions/ask-question.ts` (240줄)
- `src/discord/interactions/sdk-ask-question.ts` (223줄)

**현재 문제:**
두 파일이 95% 동일한 코드입니다.
차이점은 딱 두 가지:
- Discord component의 custom ID prefix (`askq:` vs `sdk_askq:`)
- 응답을 전달할 resolver (SessionManager의 `allowPendingAskUserQuestion()` vs `state.sdkAskQuestionResolvers`)

나머지 — 버튼 핸들러, 셀렉트 메뉴 핸들러, 모달 핸들러, `trySubmitAllAnswers()` — 전부 복붙입니다.

**개선 방향:**
`createAskQuestionHandlers(config)` 팩토리 함수를 만들어서
prefix와 resolver를 주입받고, 핸들러들을 생성하는 구조로 통합합니다.

**리스크:**
낮음. 다만 custom ID prefix를 변경하면, 배포 시점에 이미 Discord에 보내진
인터랙션 버튼들이 새 prefix를 모르기 때문에 깨질 수 있습니다.
기존 prefix를 유지하면서 내부 구현만 통합하면 안전합니다.

---

### 3. session-manager.ts (715줄)

**위치:** `src/slack/session-manager.ts`

**현재 문제:**
이름은 "Slack session manager"이지만, 실제로는 Telegram도 이 파일을 import해서 씁니다.
공유 코어가 `slack/` 하위에 있어서 의존 방향이 뒤틀려 있습니다.

한 파일 안에 다음이 전부 들어있습니다:
- Unix socket 서버 (데몬)
- JSONL 파일 감시 (chokidar)
- JSONL 파싱 (206줄짜리 `processJsonl()`)
- 메시지 중복 제거
- TODO 해시 추출
- 도구 호출/결과 추출
- 권한 요청 포워딩
- 세션 생명주기 이벤트

**개선 방향:**
1. `src/shared/jsonl-parser.ts` — JSONL 파싱 로직 추출
2. `src/shared/session-watcher.ts` — 파일 감시 + 세션 추적
3. 기존 `session-manager.ts`는 플랫폼 어댑터만 남기기
4. `slack/` 밖으로 공유 코어 이동

**리스크:**
높음. socket 서버, file watching, incremental read offset, dedupe, permission relay가
한 상태 머신으로 얽혀 있습니다.
Telegram이 같은 구현을 재사용하므로 영향 범위가 Slack보다 넓습니다.
분리 시 반드시 Telegram 쪽도 함께 테스트해야 합니다.

---

### 4. discord-app.ts (612줄)

**위치:** `src/discord/discord-app.ts`

**현재 문제:**
Discord 봇의 "모든 것"이 이 파일에 있습니다:
- 메시지 라우팅 (Claude/Codex/@mention 분기)
- 채널 자동 생성 (auto-create)
- Lazy resume (SDK 세션 복구)
- PTY vs SDK vs Codex 세션 분기
- 슬래시 커맨드 등록
- 인터랙션 핸들러 연결

결합도의 중심이라, 다른 리팩토링을 진행하려면 여기도 같이 정리해야 합니다.

**개선 방향:**
- 메시지 라우팅 → `message-router.ts`
- 세션 생성/복구 → `session-lifecycle.ts`
- 핸들러 등록 → `register-handlers.ts`
- `discord-app.ts`는 초기화와 조합만 담당

**리스크:**
중간. 기능 분리 자체는 비교적 명확하지만,
lazy resume 같은 로직은 라우팅과 세션 생성이 긴밀히 엮여있어서
인터페이스를 잘 설계해야 합니다.

---

## HIGH — 구조 개선

### 5. process-manager.ts (667줄)

**위치:** `src/discord/process-manager.ts`

**현재 문제:**
OS 프로세스 스폰, PID 추적, 헬스체크, 레지스트리 저장,
macOS 터미널 앱 연동(Terminal.app/iTerm2 창 열기), reconnect 로직이 전부 한 파일입니다.
헬스체크 메서드(`runHealthCheck`)만 107줄이고,
터미널 창 추적 로직은 macOS 전용이라 분리 가치가 높습니다.

**개선 방향:**
- `terminal-launcher.ts` — macOS 터미널 앱 스폰 전용
- `process-health-checker.ts` — PID 검증, orphan 정리
- `process-manager.ts` — 핵심 생명주기만 유지

**리스크:**
높음. macOS terminal spawn, PID 0 처리, reconnect, orphan cleanup을 건드립니다.
이 부분은 자동 테스트가 없어서 리팩토링 후 수동 검증이 필수입니다.

---

### 6. cli/memory.ts (620줄)

**위치:** `src/cli/memory.ts`

**현재 문제:**
8개의 CLI 커맨드(search, store, delete, consolidate, retag, supersede, graph, stats)가
한 파일에 순서대로 나열되어 있습니다.
각 커맨드는 독립적이라 서로 의존하지 않습니다.

**개선 방향:**
`src/cli/commands/memory/` 디렉토리로 분리.
각 커맨드를 `search.ts`, `store.ts`, `consolidate.ts` 등으로 나눕니다.

**리스크:**
낮음. 각 커맨드가 독립적이라 분리가 깔끔합니다.

---

### 7. 레지스트리 저장 패턴 3벌

**관련 파일:**
- `process-manager.ts` → `~/.sleep-code/process-registry.json`
- `channel-manager.ts` → `~/.sleep-code/session-mappings.json`
- `channel-manager.ts` → `~/.sleep-code/sdk-session-mappings.json`

**현재 문제:**
JSON 파일을 읽고/쓰고/에러 처리하는 패턴이 3번 반복됩니다.
매번 `readFile → JSON.parse → try/catch(ENOENT)` 와
`JSON.stringify → writeFile` 를 직접 구현합니다.

**개선 방향:**
`src/shared/json-store.ts` — 제네릭 JSON 파일 persistence 유틸리티.
`new JsonStore<T>(filePath)` 로 load/save/update 제공.

**리스크:**
낮음. 유틸리티 추출이라 기존 코드에 영향이 적습니다.

---

### 8. Claude SDK / Codex session manager lifecycle 공통화

**관련 파일:**
- `src/discord/claude-sdk/claude-sdk-session-manager.ts`
- `src/discord/codex/codex-session-manager.ts`

**현재 문제:**
둘 다 동일한 패턴을 별도 구현합니다:
- `sessions: Map<string, Entry>`
- `startSession() / stopSession() / getSession() / getAllSessions()`
- 상태 전이 (idle → running → ended)
- 이벤트 fan-out (onMessage, onToolCall, onError 등)

**개선 방향:**
공통 `BaseSessionManager<TEntry>` 추상 클래스를 만들고,
SDK/Codex 고유 로직만 서브클래스에서 구현합니다.

**리스크:**
중간. 두 매니저의 세부 동작(SDK의 prompt generator vs Codex의 메시지 큐)이 다르므로
추상화 수준을 잘 잡아야 합니다.

---

## MEDIUM — 코드 품질 (구조 분리 후 처리)

### 9. any 타입 46개

17개 파일에 걸쳐 `any`가 46회 사용됩니다.
주요 발생 위치: `toolInput: any`, `err: any`, guild/channel 관련 Discord.js 타입.
구조 분리가 끝난 후 파일별로 정리하는 것이 효율적입니다.

### 10. 에러 처리 패턴 불일치

- Slack: `respond(":warning: ...")`
- Discord: `throw` / `log.error()` / 무시 혼용
- Telegram: `catch (err: any)` + 제네릭 로그

플랫폼별 에러 핸들러를 `src/shared/error-handler.ts`로 통일하는 것이 목표지만,
구조 분리 이전에 손대면 churn만 늘어납니다.

### 11. 플랫폼별 outbound throttling

Slack과 Telegram에만 별도 메시지 큐 구현이 있습니다.
Discord는 별도 큐 없이 직접 전송합니다.
"MessageQueue 3벌"이 아니라 "2벌 + 정책 불일치"가 정확한 표현입니다.
우선순위가 높지 않아 구조 정리 이후 검토합니다.

---

## 삭제한 항목

### ~~세션 상태 공용 enum~~

처음 분석에서는 상태 문자열을 공용 enum으로 통합하자고 했으나,
Codex 리뷰 결과 서브시스템마다 상태의 의미가 다릅니다:
- Claude SDK: `idle | running | ended`
- Codex: `idle | running | ended` + `starting`
- ProcessManager: `running | stopped | stopping | orphaned | needs_restore`

공용 enum은 잘못된 추상화입니다. 각 서브시스템이 자체 타입을 유지하는 것이 맞습니다.

---

## 추천 진행 순서

```
1단계: ask-question 핸들러 통합 (#2)
       → 가장 쉽고, 리스크 낮고, 효과 명확 (463줄 → ~250줄)

2단계: 공통 유틸리티 추출 (#7 JsonStore, #11 등)
       → 후속 리팩토링의 기반

3단계: channel-manager 분리 (#1)
       → 가장 크지만, 2단계의 JsonStore를 활용 가능

4단계: session-manager 분리 + 위치 이동 (#3)
       → shared core를 slack/ 밖으로 이동

5단계: discord-app 분해 (#4) + process-manager 분리 (#5)
       → 3~4단계 완료 후 의존성이 줄어든 상태에서 진행

6단계: MEDIUM 항목들 (#9, #10, #11)
       → 구조 안정화 후 정리
```
