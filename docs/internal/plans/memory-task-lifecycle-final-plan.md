# Memory Task Lifecycle Final Plan

## Goal

완료된 task가 계속 `open`으로 남아 Daily Digest를 오염시키는 문제를 해결한다.  
목표는 세 가지다.

1. 기존 DB에 남아 있는 bad open task를 정리한다
2. 새 bad open task 유입을 차단한다
3. digest가 마지막 방어선 역할을 하도록 만든다

## Final Decisions

### 1. API boundary

- `MemoryService`는 `rawStore()` / `store()`로 분리한다
- `rawStore()`는 private/internal persistence primitive
- `store()`는 public API이며 항상 `normalizeMemoryInput()`을 거친다
- `storeIfNew()`도 normalization을 먼저 수행한 뒤 dedup 및 insert를 수행한다

이렇게 해서 batch distill, CLI, MCP, 기타 create path가 normalization을 우회하지 못하게 한다.

### 2. Migration strategy

- 기존 DB 정리는 **일회성 스크립트가 아니라 CLI 커맨드**로 구현한다
- 추천 형태:
  - `sleep-code memory migrate tasks --dry-run`
  - `sleep-code memory migrate tasks --apply`
  - 옵션: `--project <name>`, `--limit <n>`

이유:

- dry-run / apply / project scope를 재사용 가능
- CEO가 직접 결과를 보고 판단 가능
- 이후에도 데이터 정합성 점검용으로 다시 사용할 수 있음

### 3. Recovery strategy

- **Phase A: migration sweep**
  - 공격적으로 현재 open task를 정리
  - 단, strong-positive / no-negative 규칙을 만족하는 항목만 자동 resolve
  - ambiguous 항목은 report만 하고 보류
- **Phase B: normal operation**
  - pre-digest consolidation은 보수적 모드로 동작
  - false-positive closure를 최소화

### 4. Priority order

구현 우선순위는 다음과 같이 확정한다.

1. consolidation recovery
2. ingress normalization
3. digest defensive filter

이 순서는 CEO가 바로 체감할 수 있는 개선을 먼저 주면서, 이후 재오염을 차단하는 흐름이다.

## `normalizeMemoryInput()` Rule Set

이 rule set은 **`kind='task'`인 입력에만 우선 적용**한다.

### Rule 1. Completion-like task → fact로 변환

조건:

- completion positive signal 존재
- future/conditional negative signal 없음

동작:

- `kind: 'task' -> 'fact'`
- `status: 'resolved'`

예:

- `"모든 프로젝트 리태깅 완료. 총 412건"`
- `"README 반영 완료"`
- `"112건 삭제 완료"`

목적:

- LLM이 완료 보고를 `task`로 오분류해도 `open task`로 저장되지 않게 한다

### Rule 2. Ephemeral instruction task → skip

조건:

- 일회성 지시/요청 패턴
- 장기 기억 가치 없음

예:

- `"서버 재시작해줘"`
- `"테스트 진행"`
- `"이거 한번 확인 부탁"`

동작:

- 저장하지 않음 (`skip`)

### Rule 3. Very short task text → skip

조건:

- `text.length < 20`

동작:

- 저장하지 않음 (`skip`)

의도:

- `"README"`, `"이거 수정"`, `"테스트"` 같은 low-substance task 차단

### Rule 4. Future-action cue가 없는 task는 유지하지 않음

조건:

- completion-like도 아님
- future/imperative/assignment cue도 없음

동작:

- 기본은 `skip`
- 단, 명백한 결과 보고나 상태 요약이면 `fact`로 downgrade 가능

예:

- `"서버 재시작 없이 테스트 및 수정 진행"`
- `"메모리 정리 작업 수행"`

이 rule의 목적은 "그냥 작업 관련 문장"을 task로 저장하는 일을 줄이는 것이다.

### Rule 5. Mixed completion + future text는 auto-convert 금지

조건:

- completion positive와 future/conditional negative가 함께 존재

예:

- `"X 완료 후 Y를 해야 함"`
- `"1차 완료, 2차 작업 남음"`

동작:

- Rule 1 적용 금지
- 자동 `resolved` 금지
- 원래 task로 남기거나 보수적으로 skip

이 rule은 self-resolution 오탐을 막기 위한 safety valve다.

### Rule 6. Vague task는 skip

조건:

- concrete action/object/target이 없음
- 너무 일반적이거나 메타 수준 설명

예:

- `"작업 진행"`
- `"정리 필요"`
- `"검토하기로 함"`

동작:

- 저장하지 않음

## Detector Design

### Positive completion signals

- `완료`, `끝`, `마침`, `해결`, `적용 완료`, `삭제 완료`, `구현 완료`
- `fixed`, `done`, `resolved`, `implemented`, `finished`
- 결과 보고형 숫자/산출물 패턴
  - `총 412건`
  - `112건 삭제`
  - `README 반영 완료`

### Negative future / conditional signals

- `해야`, `필요`, `예정`, `후`, `후에`, `다음`, `남은`, `TODO`
- `확인 필요`, `진행 예정`, `해야 함`, `할 것`

### Ephemeral instruction patterns

- `해줘`, `부탁`, `진행`, `확인`, `테스트`, `재시작`
- 단, concrete long-term task와 구분되도록 길이/구체성 조건을 함께 본다

## Consolidation Plan

### 1. Shared detector reuse

`normalizeMemoryInput()`에서 쓰는 detector와 consolidation의 self-resolution detector는 같은 규칙 세트를 공유한다.

즉 별도 regex를 두 벌로 관리하지 않는다.

### 2. Migration sweep mode

CLI `memory migrate tasks`는:

1. open task 조회
2. strong-positive / no-negative task를 `resolved`
3. ambiguous task는 report only
4. 결과를 summary로 출력

### 3. Ongoing conservative mode

pre-digest consolidation은:

- self-resolution을 shared detector로 수행
- evidence-based auto-resolution도 계속 수행
- ambiguous는 닫지 않음

## Implementation Steps

### Step 1. Shared normalization + detectors

Affected files:

- `src/memory/memory-service.ts`
- 신규 helper 예: `src/memory/task-lifecycle-rules.ts`

작업:

- `normalizeMemoryInput()` 구현
- completion/future/ephemeral/vague detector 구현
- `rawStore()` 추가
- `store()` / `storeIfNew()`에서 normalization 선적용

### Step 2. Consolidation recovery path

Affected files:

- `src/memory/consolidation-service.ts`

작업:

- shared detector 재사용
- self-resolution 강화
- migration sweep에서 사용할 판정 함수 분리

### Step 3. CLI migration command

Affected files:

- `src/cli/memory.ts`

작업:

- `memory migrate tasks` 서브커맨드 추가
- `--dry-run`, `--apply`, `--project`, `--limit` 지원
- 결과 요약 출력

### Step 4. Digest defensive filter

Affected files:

- `src/memory/daily-digest.ts`

작업:

- completion-like open task를 `Action Required` / `Stalled`에서 제외

## Acceptance Criteria

1. migration dry-run이 현재 open task 중 auto-resolve 후보와 ambiguous 후보를 구분해서 보여준다
2. migration apply 후 Daily Digest의 잘못된 open task 노이즈가 눈에 띄게 줄어든다
3. 새 completion report가 distill 오분류로 `task`로 들어와도 `open task`로 저장되지 않는다
4. `"X 완료 후 Y를 해야 함"` 같은 mixed 문장은 자동 resolve되지 않는다
5. 기존 CLI/MCP/batch-distill 쓰기 경로가 모두 normalization을 거친다

## Bottom Line

최종 합의안은 다음 한 줄로 요약된다.

**기존 오염은 CLI migration sweep으로 정리하고, 새 오염은 `store()` 경계의 shared normalization으로 차단하며, 운영 중 auto-resolution은 strong rule 기반 보수 모드로 유지한다.**
