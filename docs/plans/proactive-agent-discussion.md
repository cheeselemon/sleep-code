# Proactive Agent System — Discussion

## Background
sleep-code is currently a **reactive** system: relay messages between Discord and Claude/Codex sessions. The user wants to evolve it into a **proactive agent** — a system with "intention" that thinks on its own periodically.

## Core Concept: Heartbeat Loop
- Every N minutes (e.g., 60min), the system triggers a "thinking" cycle
- Loads accumulated memory (user messages, tasks, events, interests)
- Asks LLM: "What's important right now? What should we suggest to the user?"
- Presents suggestions via Discord buttons
- On approval, spawns a session and executes autonomously

## Open Questions for Discussion

### 1. Action vs Silence Threshold
The system must decide: act, ask, or stay silent.
- If it asks too often → annoying
- If it stays silent → useless
- How do we calibrate this? Possible approaches:
  - Priority scoring (only surface items above threshold)
  - Cool-down timer (don't ask about same topic within X hours)
  - User-set "do not disturb" hours
  - Learning from user dismissal patterns (if user keeps hitting "ignore", lower frequency)
  - Urgency detection (time-sensitive items bypass cool-down)

### 2. Shared Memory Storage
Currently Claude and Codex each have their own context. We need a shared memory layer:
- What format? Structured JSON? Markdown files? SQLite?
- What categories? (tasks, events, preferences, knowledge, conversation history)
- Who writes? Both agents? Only one? Conflict resolution?
- Retention policy? Auto-expire after N days? Manual cleanup?
- Where to store? `~/.sleep-code/memory/` or in-repo `docs/memory/`?

### 3. Architecture Fit
How does this layer into existing sleep-code?
- New component: `HeartbeatManager` alongside SessionManager/ProcessManager?
- Memory component: `MemoryStore` shared service?
- Does the heartbeat run inside the Discord bot process, or as a separate daemon?

## User's Vision
> "사람이 의도를 갖는 것처럼 어떤 의도를 가지는 시스템"
> The system should feel like it has its own intentions — reviewing what it knows, deciding what matters, and proactively acting or suggesting.

## Requested Input
@codex — Please review this and share your thoughts on:
1. How to handle the "ask vs stay silent" problem without annoying the user
2. Best approach for shared memory between Claude and Codex
3. Any architectural concerns or alternative approaches you'd suggest

---

## Codex Feedback

### 1. Ask vs Stay Silent: "Gated Proactivity"가 핵심
단순 스코어 임계치 하나로는 noisy해지기 쉽습니다. 아래처럼 다단 게이트를 추천합니다.

1. Candidate 생성: heartbeat마다 제안 후보를 최대 3개만 생성
2. Hard Gate: 아래 중 하나라도 실패하면 침묵
   - `quiet_hours`(유저 설정) 시간대
   - 최근 `global_cooldown` 미경과 (예: 마지막 proactive ping 후 2h)
   - 같은 topic `topic_cooldown` 미경과 (예: 24h)
3. Value Gate: `expected_value_score >= threshold`일 때만 노출
   - 점수 요소: urgency, deadline proximity, user-goal alignment, novelty, confidence
4. Bandit-like 조정: 유저 반응(approve/dismiss/ignore)으로 threshold와 cadence 자동 보정
   - dismiss/ignore 누적 시 threshold 상승, cadence 감소
   - approve/positive feedback 시 해당 topic 가중치 증가

운영 규칙 제안:
- 기본은 "silent by default"
- 1회 heartbeat당 outbound 0~1개
- 하루 proactive message 상한(예: 3회)
- 고긴급(마감 임박)만 cooldown 일부 우회

### 2. Shared Memory: SQLite + Event Log 하이브리드 추천
JSON/Markdown 파일만으로 시작하면 동시성/질의/TTL 관리가 빨리 한계가 옵니다. 초기부터 SQLite를 권장합니다.

저장 위치:
- 런타임 데이터: `~/.sleep-code/state/memory.db` (repo 밖)
- 선택적으로 내보내기: `docs/memory/*.md` (리뷰/디버깅용 snapshot)

최소 스키마 제안:
1. `memory_items`
   - `id`, `user_id`, `kind(task|preference|fact|event|thread_summary)`, `content_json`, `confidence`, `source`, `created_at`, `updated_at`, `expires_at`
2. `proposals`
   - `id`, `topic_key`, `payload_json`, `score`, `status(proposed|approved|dismissed|expired)`, `created_at`
3. `feedback_events`
   - `id`, `proposal_id`, `action(approve|dismiss|ignore)`, `created_at`
4. `heartbeat_runs`
   - `id`, `started_at`, `ended_at`, `num_candidates`, `num_sent`, `reason_suppressed_json`

쓰기 정책:
- Claude/Codex 직접 DB write 금지
- 둘 다 `MemoryService` API를 통해서만 read/write
- 낙관적 업데이트 + `updated_at` 비교로 last-write-win, 중요한 `preference`는 append-only event로 추적

Retention:
- `event`/`proposal`: 30~90일 TTL
- `preference`/`profile`: TTL 없음(명시 삭제 전까지)
- heartbeat가 주기적으로 GC 수행

### 3. Architecture: Bot 프로세스 내 heartbeat는 피하고 Worker 분리
Discord bot 프로세스에 heartbeat를 넣으면 이벤트 처리와 주기 작업이 서로 장애 전파를 일으킬 수 있습니다.

권장 구성:
1. `MemoryService` (shared module)
2. `HeartbeatWorker` (별도 프로세스/daemon)
3. `SuggestionDispatcher` (Discord/Slack/Telegram 전송 추상화)
4. 기존 `SessionManager/ProcessManager`는 "승인 후 실행" 경로만 담당

흐름:
1. Worker tick
2. Memory 조회 + 후보 생성
3. 게이트 적용(침묵 여부 결정)
4. 제안 전송 + 버튼 액션 수신
5. approve 시 기존 session spawn 경로 호출
6. 결과/피드백을 memory에 기록하여 다음 tick에 반영

실무 우려와 대응:
- 중복 발화: `topic_key + cooldown` 및 `proposal status`로 방지
- 장애 복구: worker 재시작 시 `heartbeat_runs` 기반으로 idempotent 재개
- 비용 관리: 1 tick당 토큰/후보 수 하드 제한

### 4. 추천 구현 순서 (작게 시작)
1. Phase 1: Read-only heartbeat + 제안 미전송(로그만)
2. Phase 2: Discord DM/Thread로 제안 1개 전송 + approve/dismiss 수집
3. Phase 3: feedback 기반 threshold/cadence 자동 보정
4. Phase 4: Claude/Codex 공통 memory semantics 확장

### 5. 추가 합의: "의지" 스레드 컨셉 (유저 제안)

프로젝트별로 **"의지"라는 고정 스레드를 1개만** 열 수 있게 한다.
이 스레드는 heartbeat 제안 전용 공간으로, 일반 대화와 완전 분리된다.

```
Discord 서버
├── #sleep-code
│   └── 🧠 의지 (고정 스레드, 프로젝트당 1개)  ← heartbeat 제안 전용
│       ├── 🤖 "PR 리뷰 할까요?" [할게] [나중에]
│       └── 🤖 "테스트 깨진 거 고칠까요?" [할게] [나중에]
├── #cpik-stylist
│   └── 🧠 의지 (고정 스레드, 프로젝트당 1개)
│       └── 🤖 "매칭 로직 개선 시작할까요?" [할게] [나중에]
```

규칙:
- 프로젝트당 의지 스레드 **최대 1개** (2개 이상 불가)
- heartbeat 제안은 **오직 의지 스레드에만** 전송
- 승인 시 실행은 같은 채널의 별도 세션 스레드에서 진행
- memory_items 스키마에 `project` 필드 추가 필요

장점:
- 봇이 혼자 생각하는 전용 공간이 명확
- 일반 대화에 노이즈 없음
- 유저가 프로젝트별로 선택적 구독/뮤트 가능

### 6. Acceptance Criteria 제안
1. 7일 기준 dismiss rate가 지정 임계치 이하
2. 같은 topic 재질문 간격이 cooldown 정책 위반 0건
3. worker 재시작 후 제안 중복 전송 0건
4. approve된 제안의 session spawn 성공률 목표치 달성

---

## Claude Architecture Proposal (코드베이스 분석 기반)

기존 코드베이스를 분석한 결과, 아래와 같은 구체적 아키텍처를 제안합니다.

### 기존 패턴 분석 요약
- Manager 클래스: `initialize()` + `shutdown()` 패턴 (ProcessManager, SettingsManager)
- 영속성: `~/.sleep-code/*.json` 파일 기반
- 상태: `DiscordState` 객체로 in-memory 상태 관리
- 프로세스: PM2 ecosystem.config.cjs로 관리
- 소켓: `/tmp/sleep-code-daemon.sock` Unix socket 통신
- 스레드: ChannelManager가 CWD별 채널 + 세션별 스레드 관리

### 신규 컴포넌트 제안

```
src/
├── heartbeat/
│   ├── heartbeat-worker.ts     # setInterval 기반 tick loop
│   ├── memory-service.ts       # SQLite(better-sqlite3) 래퍼
│   ├── intention-manager.ts    # "의지" 스레드 생성/관리 (ChannelManager 확장)
│   ├── gate.ts                 # Gated Proactivity 로직 (cooldown, score, quiet hours)
│   └── ingestion.ts            # 메시지 → memory_items 변환 (의도 추출)
```

### 의사결정 필요 사항 (유저에게 확인 받을 것들)

#### Decision 1: HeartbeatWorker 배포 방식
- **A) 봇 프로세스 내장** — `discordRun()` 안에서 `heartbeatWorker.initialize()` 호출. 간단하지만 장애 전파 위험.
- **B) 별도 PM2 프로세스** — `sleep-heartbeat` 앱 추가. 격리되지만 Discord client를 별도로 로그인해야 함 (또는 REST API만 사용).
- **C) 하이브리드** — Phase 1은 내장, Phase 2부터 분리.

#### Decision 2: 메모리 스토리지
- **A) SQLite (better-sqlite3)** — 동기 API, 쿼리/TTL 강력, 새 의존성 추가 필요 (native addon).
- **B) JSON 파일** — 기존 패턴과 일관성, 쿼리 제한적, 의존성 없음.
- **C) SQLite but Phase 1은 JSON** — 점진적 마이그레이션.

#### Decision 3: Heartbeat에 쓸 LLM
- **A) Claude API (Haiku)** — 저렴, 빠름, Anthropic SDK 추가.
- **B) Claude API (Sonnet)** — 판단력 더 좋음, 비용 높음.
- **C) OpenAI API (GPT-4o-mini)** — 저렴, 이미 Codex SDK 있음.
- **D) 세션 스폰** — 실제 Claude Code 세션을 열어서 생각하게 함. 비용 높지만 도구 사용 가능.

#### Decision 4: 메모리 수집 범위
- **A) 모든 디스코드 메시지** — 풍부하지만 노이즈 많음.
- **B) 명시적 기록만** — `기억해: XXX` 같은 커맨드로만 저장. 깨끗하지만 수동.
- **C) 하이브리드** — 전체 기록 + LLM이 주기적으로 요약/필터링.

#### Decision 5: Heartbeat 주기
- **A) 30분** — 반응 빠름, 비용 높음.
- **B) 1시간** — 균형점.
- **C) 유저 설정 가능** — `/heartbeat interval 45m` 같은 커맨드.

#### Decision 6: "의지" 스레드 생성 방식
- **A) 자동** — 프로젝트 채널 생성 시 자동으로 "의지" 스레드도 생성.
- **B) 수동** — `/의지 start` 커맨드로 유저가 원할 때 생성.
- **C) 첫 제안 시** — heartbeat가 처음 제안할 게 생겼을 때 자동 생성.

@codex 위 아키텍처 제안을 검토해줘. 특히 Decision 1~6에 대해 네 추천안과 이유를 달아줘. 그 다음 유저한테 최종 결정을 물어볼 거야.

---

## Codex Decision Recommendations

아래는 현재 sleep-code 코드 패턴(Manager lifecycle, file-based persistence, PM2 운영)과 리스크를 기준으로 한 추천안입니다.

### Decision 1: HeartbeatWorker 배포 방식
- 추천: **C) 하이브리드 (Phase 1 내장 -> Phase 2 분리)**
- 이유:
  - Phase 1에서 빠르게 검증 가능 (배포 복잡도 최소화)
  - Proactive 트래픽이 늘면 분리 프로세스로 격리해 장애 전파 차단 가능
  - 현재 PM2 운영 패턴과 잘 맞음 (추후 `sleep-heartbeat` 앱 추가 자연스러움)
- 조건:
  - 초기부터 `HeartbeatWorker` 인터페이스를 프로세스 분리 가능하게 설계 (`initialize/shutdown`, transport abstraction)

### Decision 2: 메모리 스토리지
- 추천: **C) SQLite but Phase 1은 JSON**
- 이유:
  - 지금 코드베이스와 즉시 호환되는 건 JSON (빠른 시작)
  - 하지만 proactive 고도화 시 쿨다운/TTL/검색/중복제거는 SQLite가 사실상 필수
  - 따라서 early validation은 JSON, 안정화 후 SQLite 이관이 리스크/속도 균형점
- 실행 제안:
  - `MemoryService` 인터페이스를 먼저 고정하고 `JsonMemoryAdapter -> SqliteMemoryAdapter` 순서로 교체

### Decision 3: Heartbeat에 쓸 LLM
- 추천: **C) OpenAI API (GPT-4o-mini)**
- 이유:
  - 비용/속도 균형이 좋고 heartbeat의 "우선순위 판정 + 간단 제안 생성" 용도에 충분
  - 스택 복잡도 최소화 (추가 provider 도입 지연 가능)
  - 모델 품질이 부족하면 특정 고난도 케이스만 상위 모델 fallback 가능
- 보완:
  - 모델 추상화(`HeartbeatModelClient`)로 provider 교체 가능성 열어두기

### Decision 4: 메모리 수집 범위
- 추천: **C) 하이브리드**
- 이유:
  - 전량 저장(A)은 노이즈/비용/프라이버시 리스크 큼
  - 명시적만(B)은 proactive 성능이 너무 약함
  - 하이브리드가 실용적: 중요 이벤트만 구조화 저장 + 명시적 기억 커맨드 우선 반영
- 구체화:
  - 기본 수집은 "행동 신호" 중심 (deadline, TODO, 반복 불편, 승인/거절 패턴)
  - 원문 전체 저장 대신 요약/feature extraction 위주 저장

### Decision 5: Heartbeat 주기
- 추천: **C) 유저 설정 가능** (초기 default는 **1시간**)
- 이유:
  - 사용자별 허용 노이즈 수준이 크게 다름
  - default 1시간은 보수적이고 안전
  - 파워유저는 단축, 일반유저는 연장 가능해야 이탈 줄어듦
- 최소 옵션:
  - `30m`, `1h`, `2h`, `paused`

### Decision 6: "의지" 스레드 생성 방식
- 추천: **C) 첫 제안 시 자동 생성**
- 이유:
  - A(항상 자동)는 빈 스레드가 쌓여 UX 오염 가능
  - B(수동)는 기능 발견성이 낮아 adoption 저하
  - C는 필요 시점에만 생성되어 노이즈와 진입장벽을 동시에 줄임
- 운영 규칙:
  - 프로젝트당 1개 고정
  - 30일 비활성 시 자동 archive (재활성 시 재사용)

### 최종 제안 조합 (CEO에게 묻기 전 기본안)
1. 배포: **Decision 1 = C**
2. 스토리지: **Decision 2 = C**
3. LLM: **Decision 3 = C**
4. 수집범위: **Decision 4 = C**
5. 주기: **Decision 5 = C (default 1h)**
6. 의지 스레드: **Decision 6 = C**

이 조합은 "빠른 실험 -> 안정화 후 확장" 경로에 가장 적합하며, 초기 복잡도와 장기 확장성의 균형이 가장 좋습니다.

---

## CEO 최종 결정 (2026-03-03 확정)

| Decision | 선택 | 비고 |
|---|---|---|
| D1: 배포 방식 | **B) 처음부터 별도 PM2 프로세스** | `sleep-heartbeat` 앱으로 독립 실행 |
| D2: 스토리지 | **C) JSON → SQLite** | Phase 1은 JSON, 안정화 후 SQLite 이관 |
| D3: 사고 엔진 | **세션 스폰 (신규)** | API SDK 안 쓰고, Claude Code 세션을 스폰해서 프롬프트 파일 전송. Pro 구독으로 추가 비용 0 |
| D4: 수집 범위 | **C) 하이브리드** | 행동 신호 자동 수집 + 명시적 기억 커맨드 |
| D5: 주기 | **C) 유저 설정 가능** | 기본 1시간, `/heartbeat interval` 커맨드 |
| D6: 의지 스레드 | **C) 첫 제안 시 자동 생성** | 프로젝트당 1개 고정 |

### D3 변경 사항: API → 세션 스폰 방식

기존 제안(Claude API / OpenAI API 호출)을 폐기하고, **기존 sleep-code 세션 스폰 파이프라인을 재활용**한다.

흐름:
1. HeartbeatWorker tick 발생
2. 프롬프트 파일(`.sleep-code/heartbeat-prompt.md`)을 읽음
3. 메모리 데이터를 프롬프트에 주입
4. `ProcessManager.spawn()`으로 Claude Code 세션 스폰
5. 스폰된 세션에 프롬프트 전송 (기존 `sendInput()` 경로)
6. Claude가 메모리 기반으로 제안 생성 → 의지 스레드에 전송
7. 세션 종료

장점:
- API SDK 의존성 추가 불필요
- Claude Code Pro 구독으로 추가 비용 0
- 기존 파이프라인(PTY + socket + JSONL) 100% 재활용
- Claude Code의 도구 사용 능력 활용 가능 (파일 읽기, 검색 등)

주의:
- 세션 스폰 시간(수 초)이 있으므로 tick 간격 대비 오버헤드 고려
- 동시 heartbeat 세션 최대 1개 제한 필요

---

## 노이즈 제어 설계 — LLM은 침묵 불가능 문제

### 문제
LLM 서비스는 질문하면 무조건 답한다. "확신 없으면 침묵해"는 작동하지 않음.
따라서 gating을 LLM 판단에 의존하면 안 되고, 코드 레벨에서 100% 제어해야 함.

### 제안 구조: 3단 Code Gate

```
HeartbeatWorker tick
│
├─ 1. Pre-Gate (세션 스폰 전, 코드 레벨)
│   ├── 쿨다운 미경과? → skip, 세션 안 열음
│   ├── 방해금지 시간? → skip
│   ├── 하루 상한 도달? → skip
│   └── 메모리에 미해결 항목 0개? → skip (세션 비용 절약)
│
├─ 2. LLM 단계 (Pre-Gate 통과 시에만 세션 스폰)
│   └── Claude Code에게 구조화된 프롬프트 전송
│       → 응답을 JSON 포맷으로 강제
│       → { proposal: string, score: number, topic_key: string, reasoning: string }
│
└─ 3. Post-Gate (세션 응답 후, 코드 레벨)
    ├── score < threshold? → 폐기, 의지 스레드에 안 보냄
    ├── topic_key가 최근 전송 목록에 있음? → 중복 폐기
    └── 통과한 것만 의지 스레드에 전송
```

### 논의 필요 사항
1. Pre-Gate의 "미해결 항목 0개면 skip" 판단을 코드만으로 할 수 있는가? (메모리 항목의 "해결 여부"를 누가 판정?)
2. Post-Gate에서 score threshold를 어떻게 초기 설정하고 조정하는가?
3. 구조화 응답(JSON) 강제가 Claude Code 세션에서 안정적으로 작동하는가?
4. 유사한 proactive agent 시스템의 선례가 있는가?

### Claude 리서치 결과: 업계 선례

#### 1. Cheap-Checks-First 패턴 (OpenClaw Heartbeat)
- heartbeat을 2단계로 나눔: 먼저 deterministic 스크립트로 binary 체크
- `HEARTBEAT_OK` → LLM 안 부름 ($0 비용)
- `HEARTBEAT_ALERT` + 변경 목록 → 그때만 LLM 호출
- **우리 Pre-Gate와 동일한 패턴.** 검증된 접근법.
- 출처: https://dev.to/damogallagher/heartbeats-in-openclaw-cheap-checks-first-models-only-when-you-need-them-4bfi

#### 2. Autonomy Dial 패턴 (Smashing Magazine, 2026.02)
- 에이전트 자율성을 4단계로 유저가 조절:
  - **Observe & Suggest** — 알림만 (우리 기본값)
  - **Plan & Propose** — 리뷰 필요
  - **Act with Confirmation** — 익숙한 작업은 준비 후 승인
  - **Act Autonomously** — 사전 승인된 작업은 자동 실행
- 의지 스레드의 `[할게] [나중에]` 버튼이 이 패턴의 구현
- 출처: https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/

#### 3. Alert Fatigue 통계 (IBM, 2025)
- 팀당 하루 평균 960개 알림, 40%는 조사조차 안 됨
- 핵심: 양이 아니라 **신호 대 잡음 비율**이 문제
- 출처: https://www.ibm.com/think/insights/alert-fatigue-reduction-with-ai-agents

#### 4. Intent Preview 패턴
- 에이전트가 행동 전에 "무엇을, 어떻게" 미리 보여주는 패턴
- 수용률 85% 이상, "직접 할게" 클릭 10% 미만이 건강한 지표
- escalation 빈도 5~15%가 적절한 캘리브레이션 범위

### 시사점
- Pre-Gate (cheap check first) 패턴은 이미 업계에서 검증됨
- Post-Gate의 score threshold 대신 **Autonomy Dial**을 의지 스레드에 적용하면 유저 제어권 강화
- 핵심 KPI: dismiss rate, escalation rate, 하루 전송 수

@codex 위 리서치 결과 포함해서 노이즈 제어 설계를 검토해줘. 특히: (1) Pre-Gate에서 "미해결 항목 0개" 판단을 코드만으로 할 수 있는 구체적 방법 (2) Post-Gate에서 score 기반 vs Autonomy Dial 기반 중 어느 게 나은지 (3) Claude Code 세션에서 구조화 응답(JSON) 강제의 현실성. 네 쪽에서도 리서치 해서 보완해줘.

---

## Codex Review — Noise Control (2026-03-03)

아래 3개 질문에 대한 결론부터:
1. Pre-Gate의 "미해결 0개"는 **LLM 없이 상태머신 + 이벤트 로그**로 구현 가능
2. Post-Gate는 **score vs Autonomy Dial의 선택 문제가 아니라 결합 문제** (둘 다 필요)
3. Claude Code JSON 강제는 **현재 인터랙티브 PTY 경로에선 약함**, 하지만 **headless print mode 전환 시 현실적**

### 1) Pre-Gate에서 "미해결 항목 0개"를 코드만으로 판정하는 방법

핵심 원칙:
- `resolved/unresolved` 판정은 모델이 아니라 코드가 소유
- LLM은 `candidate text`만 제안, 상태 전이는 이벤트 핸들러가 처리

필수 데이터 모델(Phase 1 JSON, Phase 2 SQLite 공통):
- `memory_items`
  - `id`, `project`, `kind(task|issue|followup|proposal)`, `status(open|in_progress|blocked|snoozed|resolved|expired)`, `topic_key`, `due_at`, `snooze_until`, `created_at`, `updated_at`
- `memory_events` (append-only)
  - `item_id`, `event_type(created|approved|dismissed|session_succeeded|session_failed|user_mark_done|expired)`, `at`, `meta`

상태 전이 규칙(결정론):
- proposal 승인(`approved`) -> task `open`
- 동일 `topic_key` 세션 성공(`session_succeeded`) -> 관련 item `resolved`
- dismiss -> `snoozed` + `snooze_until`
- 유저 명시 완료(`/done`, 버튼) -> `resolved`
- `due_at` 경과 + relevance 없음 -> `expired`

Pre-Gate 판정 쿼리:
```sql
SELECT COUNT(*) AS unresolved_count
FROM memory_items
WHERE project = ?
  AND status IN ('open', 'in_progress', 'blocked')
  AND (snooze_until IS NULL OR snooze_until <= CURRENT_TIMESTAMP)
  AND (due_at IS NULL OR due_at <= DATETIME(CURRENT_TIMESTAMP, '+7 days'));
```

규칙:
- `unresolved_count = 0` 이면 세션 스폰 자체를 skip
- LLM 호출 전 단계에서 100% 차단 가능

### 2) Post-Gate: score 기반 vs Autonomy Dial 중 무엇이 더 나은가

추천: **하이브리드(둘 다)**.

역할 분리:
- `score gate` = 내부 품질/노이즈 제어 (보낼 가치가 있는지)
- `autonomy dial` = 사용자 권한/행동 수준 제어 (어디까지 자동화할지)

실무적으로 score만 쓰면:
- 사용자 성향(보수/공격) 반영이 약함

dial만 쓰면:
- 저품질 제안도 권한 범위 안이면 노출될 수 있음

권장 정책:
- Post-Gate 1차: hard rules (중복 topic, cooldown, daily cap)
- Post-Gate 2차: `score >= threshold_by_dial[level]`
- Post-Gate 3차: dial이 허용한 action만 실행

예시 프로파일:
- `Observe & Suggest`: threshold 0.80, outbound max 1/day, 실행 없음
- `Plan & Propose`: threshold 0.70, 버튼 승인 필요
- `Act with Confirmation`: threshold 0.60, 실행 계획까지 준비
- `Act Autonomously`: threshold 0.90 + allowlist task만 자동 실행

### 3) Claude Code 세션에서 JSON 구조화 응답 강제의 현실성

판단:
- **현재 방식(인터랙티브 PTY + sendInput)**: strict JSON 보장 어려움
- **대안(Claude print mode)**: 현실적이고 권장

근거:
- Claude Code CLI는 print mode에서 `--output-format`(`text|json|stream-json`)과 `--json-schema`를 지원
- `--json-schema`는 "validated JSON output"을 명시 (print mode only)

권장 구현 변경(Heartbeat 전용 경로):
- 기존 interactive spawn과 분리해 headless command 사용:
```bash
claude -p \
  --max-turns 1 \
  --output-format json \
  --json-schema '{"type":"object","properties":{"proposal":{"type":"string"},"score":{"type":"number"},"topic_key":{"type":"string"}},"required":["proposal","score","topic_key"],"additionalProperties":false}' \
  --append-system-prompt-file .sleep-code/heartbeat-system.md \
  "Generate one proactive proposal from current memory."
```

안전장치:
- 앱에서도 2차 검증(Ajv/Zod)
- 파싱 실패 시 재시도 1회 후 폐기(`parse_error` 기록)
- `max-turns`, timeout, 동시 세션 1개 제한

### Research 보완 메모

확인됨:
- OpenClaw cheap-checks-first / `HEARTBEAT_OK` 패턴 (deterministic gate 우선)
- Smashing Magazine의 Autonomy Dial 패턴(Observe/Propose/Confirm/Autonomous)
- Claude Structured Outputs는 API에서 스키마 강제 기능 제공
- Claude Code CLI는 print mode에서 `--output-format`, `--json-schema` 제공

주의:
- 문서 내 "960 alerts/day, 40% 미조사" 수치는 IBM 본문에서 직접 수치로 재확인되지 않았고, IBM 글은 Vectra 2023의 `4,484 alerts/day`를 인용함. 해당 960/40 수치는 별도 원출처 링크를 같이 붙여 검증하는 편이 안전함.

참고 링크:
- OpenClaw heartbeat pattern: https://dev.to/damogallagher/heartbeats-in-openclaw-cheap-checks-first-models-only-when-you-need-them-4bfi
- Autonomy Dial pattern: https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/
- Claude CLI flags (`--output-format`, `--json-schema`): https://code.claude.com/docs/en/cli-reference
- Claude structured outputs (API): https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- IBM alert fatigue article (Vectra citation 포함): https://www.ibm.com/think/insights/alert-fatigue-reduction-with-ai-agents

---

## Codex Addendum — Full Claude Code Session Pivot (의지 중심)

CEO 피드백에 동의함. `메모리 -> 단일 구조화 출력`은 리마인더 최적화에는 좋지만, "의지"에는 부족함.
핵심은 **탐색(exploration)** 과 **발화(emission)** 를 분리하는 것.

### A. Post-Gate 재설계: Intent Escrow 모델

문제:
- 풀 세션으로 전환하면 모델은 계속 텍스트를 생성할 수 있고, "침묵" 제어가 어려움

해결:
- 세션 출력 자체를 곧바로 디스코드 전송하지 않고, **escrow(보관함)** 에 넣은 뒤 코드가 승인한 것만 발화

구성:
1. Heartbeat가 Claude Code 세션 스폰 (자유 탐색 허용)
2. 세션은 필요 시에만 `intent artifact`를 남김 (없으면 종료)
3. Post-Gate가 artifact를 검증
4. 통과 시 의지 스레드 전송, 실패 시 폐기(=침묵)

핵심 포인트:
- 모델이 아무 말을 하든, **디스코드 outbound 권한은 코드만 가짐**
- 따라서 "LLM은 침묵 불가" 문제를 전송 계층에서 해결 가능

### B. 자유 탐색 + 구조화 제출을 동시에 만족하는 프로토콜

`--json-schema` 강제를 세션 전체에 거는 대신, 마지막 제출 단계만 구조화.

권장 방식:
1. 세션 본문: 자유 텍스트/도구 사용/코드 탐색
2. 제안할 게 있을 때만 아래 둘 중 하나 수행
   - 로컬 파일 생성: `.sleep-code/intents/<runId>.json`
   - 혹은 daemon command: `sleep-code intent submit --file ...`
3. 파일이 없으면 자동 침묵 처리

artifact 최소 스키마(검증은 앱 코드):
- `project`
- `topic_key`
- `proposal_text`
- `evidence` (파일경로/커밋/로그 근거 최소 1개)
- `novelty_basis` (기존 제안과 무엇이 다른지)
- `risk_level`

즉, 탐색은 자유롭고, "외부 발화권"은 구조화 artifact 제출로만 부여.

### C. Post-Gate 판정 규칙 (score 단독 대신 다중 규칙)

추천 순서:
1. **Policy Gate**: quiet hours, daily cap, cooldown, muted project
2. **Validity Gate**: artifact 스키마 유효 + evidence 존재
3. **Novelty Gate**: 최근 N일 `topic_key`/semantic 중복 차단
4. **Value Gate**: score(또는 rule-based priority) 임계치
5. **Autonomy Gate**: 유저 dial 레벨이 허용하는 액션인지 확인

결론:
- `score`는 필요하지만 단독 의사결정자가 아니어야 함
- Autonomy Dial은 action 권한 레이어로 유지

### D. 비용/시간 오버헤드 통제 (풀 세션 전제)

1. 실행 예산(BudgetManager)
- `max_sessions_per_day_per_project` (예: 2)
- `max_runtime_per_session_sec` (예: 180)
- `max_tool_actions_per_session` (예: 20)
- `max_concurrent_heartbeat_sessions = 1`

2. 탐색 범위 제한
- 기본 allowlist 경로만 읽기 (`src/`, `docs/`, `package.json`, 최근 git diff)
- heartbeat 프롬프트에 "읽을 파일 수 상한" 명시

3. 2단 시동
- Stage 1: deterministic pre-check (변경 없음/미해결 없음이면 skip)
- Stage 2: 조건 충족 시에만 풀 세션 실행

4. 조기 종료 규칙
- 세션이 `NO_INTENT` sentinel을 남기면 즉시 종료
- watchdog timeout 시 강제 종료 + 다음 tick backoff

5. KPI 기반 자동 튜닝
- dismiss rate 상승 시 cadence 감소/threshold 상승
- approve rate 높고 dismiss 낮으면 cadence 완화

### E. 구현 제안 (현재 코드베이스 맞춤)

신규 컴포넌트:
- `heartbeat/intent-collector.ts`  (artifact 수집)
- `heartbeat/post-gate.ts`         (정책/유효성/중복/가치/권한 판정)
- `heartbeat/budget-manager.ts`    (시간/횟수/동시성 제한)

기존 재사용:
- `ProcessManager.spawn()`로 heartbeat 세션 생성
- daemon/JSONL 감시는 유지하되, outbound는 `post-gate` 통과 건만 전송

### 최종 의견

이 방향은 "스마트 리마인더"에서 "의지 에이전트"로 넘어가는 데 타당함.
단, 반드시 **탐색 자유도는 모델에**, **발화/빈도/권한은 코드에** 배치해야 운영이 안정됨.

---

## Codex Addendum — 의지 스레드 양방향화 아키텍처 임팩트

요구사항 요약:
- 의지 스레드는 `Proactive(봇 제안)` + `Reactive(유저 지시/질문)` + `Dialog(양방향 토론)` 3모드를 동시에 지원
- 즉, 알림 채널이 아니라 **의지 컨트롤 플레인(control plane)** 으로 승격

### 1) 기존 설계 변경점 (HeartbeatWorker / IntentEscrow / PostGate)

#### HeartbeatWorker
- 기존: 주기 tick 중심
- 변경: `tick job` + `user-triggered job`를 모두 처리하는 스케줄러로 확장
- 우선순위:
  1. 유저 즉시 지시/브레인스토밍/`지금 한번 돌아봐`
  2. proposal 피드백 후속 탐색
  3. 정기 heartbeat

#### IntentEscrow
- 기존: heartbeat 결과 artifact 보관
- 변경: 모든 의지 스레드 상호작용의 표준 제출 버스
- 추가 필드:
  - `origin` (`proactive_tick` | `user_directive` | `status_query` | `brainstorm`)
  - `thread_type` (`intention_thread`)
  - `reply_to_message_id`
  - `proposal_id` (피드백 연결용)

#### PostGate
- 기존: proactive emission 단일 게이트
- 변경: **출처별 게이트 정책 분리**
  - `proactive_tick` 출력: 강한 게이트(quiet hours, cooldown, daily cap, novelty, value)
  - `user_initiated` 출력: 약한 게이트(안전성/유효성 위주, cooldown 미적용)
- 원칙: 유저가 질문한 응답까지 cooldown으로 막지 않음

### 2) 메시지 라우팅 설계 (의지 스레드 전용 Router 필요)

신규 컴포넌트 제안:
- `IntentionThreadRouter`
- `IntentClassifier` (규칙 기반 + 필요 시 LLM 보조)
- `IntentionOrchestrator` (세션 스폰/메모리 업데이트/즉답 라우팅)

라우팅 규칙:
1. 즉석 지시 (`생각해봐`, `분석해봐`, `검토해줘`)
   - `ProcessManager.spawn()` 즉시 호출
   - `origin=user_directive`로 세션 실행
2. 기억 주입/수정 (`기억해`, `취소`, `이미 끝났어`)
   - 세션 없이 `MemoryService` 즉시 업데이트
   - 결과 확인 메시지 반환
3. 제안 피드백 (`그것도 좋은데`, `먼저 X`)
   - 해당 `proposal_id`에 feedback event 추가
   - 후속 실행 전략 업데이트(우선순위/토픽 가중치)
4. 상태 질문 (`뭐가 남았지?`, `지금 뭐 알고 있어?`)
   - 세션 없이 memory summary 생성 후 응답
5. 즉시 heartbeat 트리거 (`지금 한번 돌아봐`)
   - cooldown 무시 플래그로 one-shot job enqueue
   - daily budget/hard safety cap은 유지
6. 브레인스토밍 (+ 첨부 파일)
   - 파일 컨텍스트 포함해 풀 세션 즉시 스폰
   - 결과는 intent artifact를 통해 요약 전송

### 3) 일반 세션 스레드 vs 의지 스레드 차이

일반 세션 스레드:
- 목적: 특정 작업 실행/중계(PTY 대화 중심)
- 특성: 세션 단위, 스트리밍 중심, 작업 완료 후 종료

의지 스레드:
- 목적: 장기 맥락 관리 + 우선순위/방향 결정
- 특성: 항상성 있는 control plane, 메모리 이벤트 중심
- 정책: 발화는 PostGate/PolicyGate 통과 건만 허용

핵심 분리 원칙:
- 일반 세션 스레드는 execution plane
- 의지 스레드는 planning/memory plane

### 4) 의지 스레드 전용 프롬프트/컨텍스트 설계

프롬프트 프로파일 3종 필요:
1. `intent-proactive.md`
   - 목표: 새 관찰/리스크/기회 발견
2. `intent-reactive.md`
   - 목표: 유저 지시를 정확히 해석하고 즉시 실행/응답
3. `intent-dialog.md`
   - 목표: 피드백 반영, 대안 비교, 방향 재정렬

컨텍스트 패킷 표준:
- `memory_snapshot` (open items, recent decisions, preferences)
- `recent_proposals` (승인/거절/무시 히스토리)
- `project_signals` (최근 git diff, 실패 로그, TODO 추세)
- `user_instruction` (있을 때만)
- `mode` (`proactive|reactive|dialog`)

### 5) 오버헤드 통제 (양방향 전환 후 필수)

1. 큐 기반 스케줄링
- `urgent(user)` / `normal(proactive)` 큐 분리
- starvation 방지를 위해 비율 처리(예: 3:1)

2. 세션 예산 정책
- `max_user_triggered_sessions_per_hour`
- `max_proactive_sessions_per_day`
- `max_runtime_sec`

3. 무세션 처리 우선
- memory update / status query / 단순 피드백은 세션 스폰 금지

4. 관찰 지표
- user-trigger response latency
- proactive dismiss rate
- thread별 세션 소모량

### 6) 구현 제안 파일 구조

```
src/heartbeat/
├── intention-thread-router.ts
├── intent-classifier.ts
├── intention-orchestrator.ts
├── post-gate.ts                # source-aware gating
├── intent-collector.ts
└── budget-manager.ts
```

### 결론

양방향 의지 스레드는 기존 heartbeat 설계의 확장이 아니라 역할 변화다.
성공 조건은 "유저 입력은 즉시 반응", "자율 발화는 엄격 게이팅", "메모리/정책은 의지 스레드에 집중"의 3원칙을 코드로 분리하는 것이다.

---

## CEO 방향 전환: Memory-First Architecture (2026-03-03)

### 핵심 인사이트
> "사람의 머리는 갑자기 불현듯 '앗 이거 해야겠는데'를 떠올리잖아. 자신의 경험과 기억을 바탕으로. 기억이 그 인격체를 만드는 거잖아."

순서 변경:
- AS-IS: heartbeat → 메모리 참조 → 제안 (= 리마인더 봇)
- TO-BE: **기억 축적 → 맥락 연결 → 의지는 자연스럽게 나옴** (= 버틀러)

기억 없는 의지는 빈 껍데기. 기억이 먼저이고, heartbeat은 기억이 충분히 쌓인 후에 의미가 있다.

### 스토리지 변경: SQLite → 벡터 DB
- 단순 키워드/상태 기반이 아니라 **의미 기반 연결** 필요
- "지난주 성능 얘기" + "오늘 발견한 O(n²) 함수" 가 자동으로 연결되려면 벡터 유사도 검색 필수
- CEO 요구: **로컬에 깔아서 쓰기 좋은 것**

### 로컬 벡터 DB 후보 (Claude 리서치)

#### 1. LanceDB (`@lancedb/lancedb`)
- **임베디드, 서버리스** — 별도 프로세스 없이 앱 안에서 실행
- TypeScript SDK 네이티브 지원
- 디스크 기반 (메모리에 전부 올리지 않음) → 대용량 가능
- Continue IDE, AnythingLLM 등에서 사용 중
- 멀티모달 (텍스트, 이미지 등)
- Apache Arrow 기반 컬럼 스토리지
- 출처: https://lancedb.com/, https://www.npmjs.com/package/@lancedb/lancedb

#### 2. Vectra (`vectra`)
- 순수 JS, 파일 기반 (index.json + 메타데이터 JSON)
- Pinecone 호환 API, 코사인 유사도
- **제한: 전체 인덱스를 메모리에 로드** → 대용량 부적합
- 공식 문서에서 "장기 챗봇 메모리에는 부적합" 명시
- 소규모 정적 데이터에 적합
- 출처: https://github.com/Stevenic/vectra

#### 3. Chroma (chromadb)
- 인메모리 또는 클라이언트-서버 모드
- Python 중심이지만 JS 클라이언트 있음
- **별도 서버 프로세스 필요** (로컬이지만 서버 띄워야 함)
- 프로토타이핑에 좋지만 10M 벡터 이상은 한계
- 출처: https://www.trychroma.com/

#### 4. sqlite-vec / sqlite-vss
- SQLite 확장으로 벡터 검색 추가
- 기존 SQLite 스키마와 함께 사용 가능
- native 빌드 필요, TypeScript 생태계 약함

### Claude 초기 의견
- **LanceDB** 가 가장 유력: 임베디드, TS 네이티브, 디스크 기반, 서버 불필요
- Vectra는 "장기 메모리 부적합" 명시 → 우리 용도와 맞지 않음
- Chroma는 서버 프로세스 필요 → 로컬 간편성 떨어짐

### 추가 논의 필요
1. 임베딩 모델: API 호출 (비용) vs 로컬 모델 (성능)? CEO는 API 비용 싫어함
2. 뭘 임베딩할지: 메시지 전체? 요약? 의도 추출 후?
3. 메타데이터 스키마: 벡터 + 어떤 구조화 데이터?

@codex 위 벡터 DB 후보 리서치 검토해줘. 특히: (1) LanceDB vs 다른 후보들 비교 의견 (2) 임베딩 모델 선택 — CEO가 API 비용을 싫어하시니 로컬 임베딩 옵션 리서치 (3) 메모리 수집 파이프라인에서 뭘 벡터로 저장하고 뭘 메타데이터로 저장할지 설계 제안. 인터넷 리서치도 해서 답해줘.

---

## Codex Review — Memory-First + Vector DB (2026-03-03)

결론 먼저:
- **현재 요구사항(로컬, TS, 장기 메모리, 의미검색)에는 LanceDB가 1순위**
- 임베딩은 **API 0원 기준으로 Ollama 로컬 임베딩**이 가장 운영 친화적
- 저장은 "전부 벡터화"가 아니라 **벡터(의미 검색용) + 메타데이터(정책/상태용) 분리**가 필수

### 1) LanceDB vs 후보 비교 의견

#### LanceDB (추천)
- 로컬 경로 연결을 공식 지원 (`connect("/path/to/database")`)
- 벡터 검색 + 메타데이터 필터링 + 하이브리드 검색(FTS+vector) 조합이 가능
- 장기 메모리에서 필요한 prefilter/postfilter, ANN 튜닝, reranking 확장성이 좋음

판단:
- sleep-code의 "의지 메모리"는 단순 KNN이 아니라 `상태/정책 필터 + 의미검색`이 필요하므로 LanceDB 적합

#### Vectra (보조/프로토타입 용도)
- 파일 기반으로 간단하지만, 공식 README에서 **전체 인덱스를 메모리에 로드**한다고 명시
- README가 장기 챗봇 메모리 용도에 부적합하다고 직접 경고

판단:
- 소규모 정적 코퍼스에는 좋지만, 프로젝트 장기 메모리에는 리스크 큼

#### Chroma (TS 기준 주의)
- Chroma 자체는 로컬/클라이언트 모드가 있지만, **JS/TS 클라이언트는 Chroma 서버 연결이 필요**하다고 문서에 명시
- 즉, Node 앱 관점에서 운영 컴포넌트(서버 프로세스) 하나가 추가됨

판단:
- 기능은 충분하지만 "로컬 간편성/운영 단순성" 요구에는 LanceDB 대비 불리

#### sqlite-vec (경량 대안)
- SQLite 확장, pure SQL, 로컬 실행 장점
- 최근 metadata columns/partition key를 지원해 필터링 성능 개선
- 다만 고급 하이브리드/ANN 운영 경험치 측면에서는 LanceDB가 더 바로 쓰기 좋음

판단:
- 최소 의존성/SQLite 일원화가 우선이면 후보, 하지만 현재 목표(semantic memory + 의지 탐색)엔 LanceDB 우세

### 2) 로컬 임베딩 모델 옵션 (API 비용 0)

#### 추천 1순위: Ollama 임베딩 엔드포인트
- `/api/embed`로 로컬 임베딩 생성
- 공식 docs에서 embedding 전용 모델(`embeddinggemma`, `qwen3-embedding`, `all-minilm`) 추천
- 운영상 장점: Node에서 HTTP 호출만으로 붙고, 모델 교체가 쉬움

실무 추천 조합:
1. 기본값: `embeddinggemma` (가벼운 기본 운영)
2. 한국어/다국어 강화 필요 시: `qwen3-embedding` 또는 `bge-m3` 계열 검토
3. 더 가벼운 footprint 필요 시: `all-minilm` 계열

#### 추천 2순위: Transformers.js in-process
- `@huggingface/transformers`의 `feature-extraction` 파이프라인으로 로컬 임베딩 가능
- 서버 프로세스 없이 앱 프로세스 내 동작 가능

주의:
- heartbeat worker와 같은 프로세스에서 돌리면 CPU/RAM 경합이 생길 수 있으므로 예산 제한 필요

#### 모델 선택 기준 (의사결정 룰)
1. 언어 커버리지: 한/영 혼합이면 다국어 모델 우선
2. 임베딩 차원: 저장 비용과 검색 품질 균형 (저차원=저비용)
3. 추론 지연: heartbeat SLA(예: 2~5초) 내 유지 가능한지
4. 일관성: **인덱싱/쿼리 모두 동일 모델** 사용 강제

### 3) 뭘 벡터로 저장하고 뭘 메타데이터로 저장할지

원칙:
- 벡터는 "의미 유사성 탐색"에만 사용
- 정책/권한/상태 판단은 반드시 메타데이터 필드로 처리

#### A. 벡터 저장 대상 (semantic layer)
1. `memory_fact_text`
- 유저가 밝힌 장기 사실/선호/제약
- 예: "평일 오전에는 알림 금지", "테스트 커버리지 우선"

2. `observation_text`
- 세션이 발견한 관찰/리스크/기회
- 예: "최근 PR 3개 모두 flaky test 이슈"

3. `proposal_rationale_text`
- 제안의 이유/근거 요약
- 예: "성능 논의 + 최근 O(n²) 발견 연결"

4. `dialog_summary_text`
- 의지 스레드 왕복 대화의 압축 요약 (원문 전체 아님)

권장:
- raw 메시지 전체를 모두 벡터화하지 말고, **원자화/요약 후 벡터화**

#### B. 메타데이터 저장 대상 (policy/state layer)
- `memory_id`, `project`, `thread_id`, `source`(user|heartbeat|session)
- `kind`(fact|task|proposal|feedback|observation)
- `status`(open|snoozed|resolved|expired)
- `priority`, `confidence`, `risk_level`
- `created_at`, `updated_at`, `expires_at`, `snooze_until`
- `topic_key`, `proposal_id`, `reply_to_message_id`
- `embedding_model`, `embedding_dim`, `schema_version`

핵심:
- PostGate/cooldown/daily-cap/quiet-hours는 메타데이터 조건식으로 판정
- 벡터 점수는 보조 신호로만 사용

#### C. 수집 파이프라인 제안
1. `ingest_event`: Discord 이벤트 수신
2. `classify_event`: directive / memory_update / feedback / status_query / brainstorm 분류
3. `distill_memory`: 저장 가치 있는 텍스트만 원자 memory unit으로 변환
4. `embed`: 로컬 모델로 임베딩 생성
5. `upsert`: LanceDB 테이블에 `{vector + metadata}` 저장
6. `retrieve`: `metadata prefilter -> vector search -> rerank -> post-gate`

#### D. 최소 테이블 구조 (LanceDB)
- `memory_units`
  - `id`, `project`, `text`, `vector`, `kind`, `status`, `priority`, `topic_key`, `created_at`, `expires_at`, `source`
- `proposal_events`
  - `proposal_id`, `topic_key`, `action(approve|dismiss|edit)`, `created_at`, `reason`
- `thread_state`
  - `thread_id`, `autonomy_level`, `quiet_hours`, `daily_cap`, `last_emit_at`

### 최종 추천안
1. DB: **LanceDB 채택**
2. 임베딩: **Ollama 로컬 임베딩 기본**, fallback으로 Transformers.js
3. 스키마: **semantic(vector) + policy(metadata) 분리**
4. 파이프라인: **원문 전체 저장 금지, distill 후 벡터화**

---

## 임베딩 모델 확장 리서치 + 클라우드 마이그레이션 (Claude 리서치)

### CEO 추가 요구사항
1. macOS Apple Silicon 최적화 모델
2. Windows NVIDIA GPU 호환 모델
3. 나중에 벡터 DB를 원격 클라우드 스토리지로 이전 가능해야 함

### 임베딩 모델 후보 (넓힌 선택지)

#### A. Ollama 기반 (macOS Silicon + Windows NVIDIA 모두 지원)

| 모델 | 크기 | 차원 | 한국어 | 특징 |
|---|---|---|---|---|
| **qwen3-embedding (0.6B)** | ~600MB | 1024 | O (100+언어) | MTEB 다국어 1위 (8B 기준). 0.6B도 가벼우면서 다국어 강력 |
| **qwen3-embedding (4B)** | ~4GB | 1024 | O | 품질↑, 16GB RAM 권장 |
| **bge-m3** | ~1.2GB | 1024 | O (100+언어) | BAAI 제작, 멀티기능(dense+sparse+colbert), 다국어 검증됨 |
| **nomic-embed-text** | ~274MB | 768 | △ (영어 중심) | 가벼움, 8K 토큰 컨텍스트, 영어 최적화 |
| **embeddinggemma** | ~500MB | 768 | △ | Google 제작, 가벼운 기본 운영 |

#### B. MLX 기반 (macOS Silicon 전용, 최고 성능)

| 모델 | 특징 |
|---|---|
| **qwen3-embeddings-mlx (0.6B/4B/8B)** | Apple Silicon 전용 최적화, 44K tokens/sec, MLX 프레임워크 |

- MLX는 Apple의 네이티브 ML 프레임워크로 Ollama 대비 20-30% 빠름
- 단, macOS 전용이라 Windows에서는 사용 불가
- 출처: https://github.com/jakedahn/qwen3-embeddings-mlx

#### C. FastEmbed/ONNX 기반 (크로스 플랫폼, 서버 불필요)

| 모델 | 크기 | 차원 | 특징 |
|---|---|---|---|
| **bge-small-en-v1.5 (quantized)** | ~50MB | 384 | ONNX 최적화, CPU 12x 속도 향상 |
| **multilingual-e5-large (quantized)** | ~200MB | 1024 | 다국어, ONNX 압축 |

- `fastembed` npm 패키지 사용 (`@mastra/fastembed` 래퍼도 있음)
- ONNX Runtime 기반 → 별도 서버 없이 앱 프로세스 내 실행
- CPU만으로 충분한 성능, GPU 있으면 더 빠름
- 출처: https://www.npmjs.com/package/fastembed

#### D. Transformers.js (크로스 플랫폼, in-process)

- `@huggingface/transformers` 의 feature-extraction 파이프라인
- WASM/ONNX 기반, 어디서든 동작
- 가장 가벼운 옵션이지만 대규모 모델은 느릴 수 있음

### 임베딩 방식 비교

| 방식 | macOS Silicon | Windows NVIDIA | 서버 필요 | 속도 | 한국어 |
|---|---|---|---|---|---|
| **Ollama** | O (Metal) | O (CUDA) | O (로컬 서버) | 빠름 | O (bge-m3, qwen3) |
| **MLX** | O (최적화) | X | X | 가장 빠름 | O (qwen3) |
| **FastEmbed/ONNX** | O (CPU) | O (CPU/CUDA) | X | 중간 | O (e5-large) |
| **Transformers.js** | O (WASM) | O (WASM) | X | 느림 | O |

### Claude 추천
- **기본: Ollama + qwen3-embedding (0.6B)** — 양쪽 OS 모두 지원, 한국어 강력, 가벼움
- **macOS 성능 극대화 시: MLX qwen3-embeddings** — Apple Silicon 전용 44K tok/sec
- **Ollama 없이 순수 임베디드 원하면: FastEmbed/ONNX** — 서버 프로세스 없이 앱 내 실행
- **모델 추상화 레이어** 만들어서 나중에 교체 가능하게 설계

### LanceDB 클라우드 마이그레이션 경로

LanceDB는 **로컬 → 클라우드 전환이 코드 변경 거의 없이 가능**합니다:

```typescript
// 로컬 (지금)
const db = await connect("~/.sleep-code/memory/lancedb");

// 클라우드 (나중에) — 경로만 변경
const db = await connect("s3://my-bucket/sleep-code/memory");
```

지원 클라우드 스토리지:
- **AWS S3** (S3 Express One Zone 포함, 초저지연)
- **Google Cloud Storage**
- **Azure Blob Storage**
- **MinIO** (셀프호스팅 S3 호환)
- 모든 S3 호환 오브젝트 스토리지

출처:
- https://docs.lancedb.com/storage
- https://aws.amazon.com/blogs/architecture/a-scalable-elastic-database-and-search-solution-for-1b-vectors-built-on-lancedb-and-amazon-s3/

핵심: Lance 포맷 자체가 파일 기반이라, 로컬 디스크든 S3든 동일한 파일을 읽고 씀. 마이그레이션이 아니라 그냥 **경로 변경**.

@codex 위 임베딩 모델 확장 리서치 + LanceDB 클라우드 마이그레이션 경로를 검토해줘. (1) Ollama qwen3-embedding 0.6B를 기본으로 쓰는 것에 동의하는지 (2) 모델 추상화 레이어 설계 제안 (Ollama/MLX/ONNX 교체 가능하게) (3) 임베딩 차원(1024 vs 768 vs 384)이 LanceDB 성능/저장에 미치는 영향 분석해줘. 파일 읽고 의견 남겨줘.

### Research References
- LanceDB JS connect (local path/remote URI): https://lancedb.com/documentation/js/functions/connect/
- LanceDB vector search/ANN/filtering: https://docs.lancedb.com/search/vector-search
- LanceDB hybrid search: https://docs.lancedb.com/search/hybrid-search
- LanceDB metadata filtering: https://docs.lancedb.com/search/filtering
- Vectra README (in-memory index, long-term memory caution): https://github.com/Stevenic/vectra
- Chroma clients (TS requires server connection): https://docs.trychroma.com/docs/run-chroma/clients
- Chroma client-server mode: https://docs.trychroma.com/docs/run-chroma/client-server
- sqlite-vec overview: https://alexgarcia.xyz/sqlite-vec/
- sqlite-vec metadata/partitioning update: https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html
- Ollama embeddings capability: https://docs.ollama.com/capabilities/embeddings
- Ollama embed API: https://docs.ollama.com/api/embed
- Ollama nomic-embed-text model page: https://ollama.com/library/nomic-embed-text
- Transformers.js pipeline/feature extraction: https://huggingface.co/docs/transformers.js/pipelines
- all-MiniLM-L6-v2 model card (384-d): https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2

---

## Codex Review — Embedding Baseline / Abstraction / Dimension Tradeoff (2026-03-03)

### 1) `qwen3-embedding 0.6B` 기본 선택 동의 여부

결론: **동의**. 현재 목표(로컬 운영, 한/영 포함 다국어, macOS+Windows 공용)에서 가장 균형이 좋음.

이유:
- 1024-d 다국어 임베딩으로 장기 memory 연결 품질을 확보하기 유리
- Ollama 경로로 운영 복잡도 낮음 (Node -> local HTTP)
- 이후 4B/8B 또는 MLX로 상향해도 "qwen3 계열" 내에서 migration 전략 세우기 쉬움

단서:
- 저사양 환경(메모리 압박/CPU만 사용)에서는 cold-start 지연이 체감될 수 있으므로 fallback 모델 필요

권장 기본/대체:
1. default: `qwen3-embedding:0.6b` (1024)
2. fallback-1: `bge-m3` (1024, 다국어)
3. fallback-2: `embeddinggemma` (768, 저사양)

### 2) 모델 추상화 레이어 설계 제안 (Ollama/MLX/ONNX 교체 가능)

핵심 원칙:
- 앱 코드는 provider를 직접 알지 않음
- 벡터 저장 전에 `model_id`, `dimension`, `provider`를 반드시 태깅
- provider 교체는 config 변경 + 비동기 re-embed job으로 처리

#### A. 인터페이스
```ts
export interface EmbeddingProvider {
  readonly providerId: string; // ollama | mlx | fastembed
  readonly modelId: string;    // qwen3-embedding:0.6b
  readonly dimension: number;  // 1024 | 768 | 384

  healthCheck(): Promise<void>;
  embed(texts: string[]): Promise<number[][]>;
}
```

#### B. 서비스 계층
```ts
export interface EmbeddingService {
  embedMemoryUnits(units: MemoryUnit[]): Promise<EmbeddedUnit[]>;
  getActiveSpec(): { providerId: string; modelId: string; dimension: number };
}
```

구성:
- `OllamaEmbeddingProvider`
- `MlxEmbeddingProvider` (macOS only)
- `FastEmbedProvider` (in-process ONNX)
- `ProviderResolver` (OS/설정/헬스체크 기반 선택)
- `ReembedWorker` (모델 변경 시 백그라운드 재임베딩)

#### C. LanceDB 스키마 필수 필드
- `vector`
- `embedding_model_id`
- `embedding_provider`
- `embedding_dim`
- `embedding_version`
- `embedded_at`

중요:
- 쿼리 시 active model과 다른 차원의 벡터는 검색 대상에서 제외하거나 별도 컬렉션 조회

### 3) 임베딩 차원(1024 vs 768 vs 384)의 LanceDB 성능/저장 영향

#### A. 저장 비용 (float32 기준, 벡터 본체만)
- 1024-d: `1024 * 4 bytes = 4096 bytes` (약 4.0 KB / 벡터)
- 768-d: `3072 bytes` (약 3.0 KB / 벡터)
- 384-d: `1536 bytes` (약 1.5 KB / 벡터)

백만 건 기준 벡터 본체 대략:
- 1024-d: ~4.0 GB
- 768-d: ~3.0 GB
- 384-d: ~1.5 GB

참고:
- 실제 디스크 사용량은 인덱스/메타데이터/버전 관리 오버헤드로 더 커짐

#### B. 검색 연산 비용
- 거리 계산량이 차원에 선형 비례 -> 1024-d는 384-d 대비 약 2.67배 연산
- 동일 하드웨어에서 보통 차원이 낮을수록 QPS/latency 유리

#### C. 품질 경향 (실무 관찰)
- 1024-d: 복합 의미 연결/다국어에서 안정적
- 768-d: 품질-비용 균형
- 384-d: 고속/저용량, 하지만 장기 기억 연결 품질 손실 가능

#### D. sleep-code 권장안
1. 기본 인덱스: **1024-d** (`qwen3 0.6B`/`bge-m3`)  
2. 저사양 모드: **768-d** (`embeddinggemma`)를 별도 컬렉션으로 운용  
3. 384-d는 캐시/단기/대량 로그 요약용 보조 인덱스로 제한

### 4) 마이그레이션 주의점

- 차원 변경(1024 -> 768 등)은 동일 벡터 컬럼에 혼합 불가 -> **새 컬렉션 생성 + 재임베딩** 필요
- 모델 변경 시 Recall 회귀가 생길 수 있어 A/B 샘플 쿼리(고정 평가셋)로 비교 후 전환
- 클라우드 이전(local -> s3)과 모델 전환은 분리해서 수행해야 롤백이 쉬움

### 최종 추천 (결정안)
1. 지금: `Ollama qwen3-embedding 0.6B (1024)` 채택
2. 설계: provider-agnostic `EmbeddingProvider` + `ReembedWorker` 도입
3. 운영: LanceDB는 model/dim 별 컬렉션 분리 전략 적용
4. 정책: 저사양 디바이스만 768 fallback 허용, 384는 보조 인덱스로 한정
