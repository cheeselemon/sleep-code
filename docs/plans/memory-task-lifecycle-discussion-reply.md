# Memory Task Lifecycle Discussion Reply

## Note

방금 읽은 `docs/internal/plans/memory-task-lifecycle-discussion.md`에는 아직 아래 3개 보완 의견이 반영되어 있지는 않았습니다.  
그래도 메시지로 준 3개 포인트 기준으로 답합니다.

## 1. "Distill을 조이는 것보다 store 단계 hard rule이 더 확실하다"

이 방향성에는 대체로 동의합니다.  
다만 "하드 룰이 필요하다"와 "그 로직을 `MemoryService.store()` 내부에 넣는다"는 분리해서 봐야 합니다.

### 동의하는 부분

- 맞습니다. LLM 분류는 아무리 프롬프트를 조여도 오분류가 남습니다.
- 따라서 `kind=task` + completion-like text를 차단하는 deterministic gate는 반드시 있어야 합니다.
- 이 gate가 없으면 ingest 품질이 계속 흔들리고, downstream cleanup이 끝없이 뒤따라가야 합니다.

### 반론 / 보완

저는 이 하드 룰을 **저수준 DB primitive인 `store()` 안에 직접 묻는 것**에는 신중해야 한다고 봅니다.

이유:

1. `store()`는 persistence primitive라서, 입력을 가능한 한 그대로 저장하는 편이 역할이 명확합니다.
2. 여기에 의미 변환 로직을 넣으면 호출자가 `task`를 넣었는데 내부에서 `fact/resolved`로 바뀌는 side effect가 생깁니다.
3. 나중에 CLI/MCP/manual backfill 같은 다른 쓰기 경로에서도 예상 밖 동작이 생길 수 있습니다.

### 권장안

가장 좋은 형태는:

1. `normalizeBeforeStore()` 같은 공용 normalization layer를 만든다
2. collector / batch runner / CLI ingest가 모두 이 함수를 거친다
3. `store()`는 최종 persistence만 담당한다

즉 **"store 단계 hard rule"의 취지는 맞지만, 구현 위치는 `store()` 내부보다 store 직전 공용 normalize 계층이 더 안전하다**는 입장입니다.

### `kind=fact, status=resolved` 변환에 대해서

이건 pragmatic하게는 괜찮습니다. 다만 의미적으로는 약간 어색합니다.

- `fact`는 원래 lifecycle 대상이 아니므로 `resolved`가 좀 이상함
- 하지만 현재 스키마는 모든 kind에 status를 강제하므로, 단기적으로는 실용적인 선택일 수 있습니다

제가 더 선호하는 우선순위는:

1. 가능하면 `kind=task -> kind=fact`로 변환
2. status는 현재 스키마 제약상 `resolved`를 허용
3. 장기적으로는 "status가 필요한 kind"와 아닌 kind를 분리

핵심은 `open task`로 남기지 않는 것입니다.

## 2. "Self-resolution은 '완료'만 보고 닫으면 위험하다"

여기는 거의 전적으로 동의합니다.  
단순 completion regex만으로 self-resolution을 태우면 오탐이 납니다.

예:

- `"X 완료 후 Y를 해야 함"`
- `"1차 완료, 2차 작업 남음"`
- `"A 구현 완료 여부 확인 필요"`
- `"빌드 완료되면 배포해야 함"`

이런 문장은 completion token이 있지만 실제로는 open task일 수 있습니다.

### 그래서 필요한 것

self-resolution은 `completion keyword exists`가 아니라, **completion assertion detector**로 가야 합니다.

최소한 아래 2단 조건이 필요합니다.

1. Positive completion signals
   - `완료`, `끝`, `마침`, `해결`, `적용 완료`, `삭제 완료`, `구현 완료`, `fixed`, `done`, `resolved`
   - 결과형 숫자/산출물 패턴: `총 412건`, `112건 삭제`, `README 반영 완료`
2. Negative future/conditional signals
   - `해야`, `필요`, `예정`, `후`, `후에`, `다음`, `남은`, `TODO`, `확인 필요`, `진행 예정`

### 판단 규칙 제안

- positive만 있고 negative가 없으면 auto-resolve 후보
- positive와 negative가 함께 있으면 auto-resolve 금지
- ambiguous하면 유지하고, 다른 evidence를 기다림

즉 self-resolution은 유지하되, **regex 1개가 아니라 positive/negative rule set**으로 가야 합니다.

## 3. "task는 명시적 TODO/해야 해일 때만 만들자"

여기에는 절반 동의, 절반 반론입니다.

### 동의하는 부분

- 지금 시스템은 task recall보다 precision이 훨씬 더 중요합니다.
- digest 오염 비용이 task 누락 비용보다 큽니다.
- 그래서 task 생성 기준을 훨씬 더 보수적으로 만드는 것은 맞습니다.

### 반론

하지만 "명시적 TODO/해야 해/이거 해야 해"일 때만 task를 만들면 recall이 너무 떨어질 가능성이 큽니다.

실제 작업 지시는 종종 이렇게 나옵니다:

- `"README에 이 caveat 추가하기로 함"`
- `"interruptSession 먼저 구현"`
- `"다음으로 memory commands 정리"`
- `"남은 작업은 A, B, C"`

이런 건 literal TODO 문구는 없지만, 실제로는 충분히 actionable한 task입니다.

### 권장안

`task`를 완전히 explicit-only로 제한하기보다, **future-action + commitment/assignment cue가 동시에 있을 때만 task 생성**으로 좁히는 게 더 좋습니다.

예를 들면:

- explicit TODO/imperative
  - `TODO`, `해야`, `해줘`, `해라`, `필요`
- commitment / planning cue
  - `하기로`, `먼저`, `다음으로`, `남은 작업`, `will`, `need to`, `plan to`
- owner/actionability cue
  - 구체 작업 대상이 있음
  - 한 문장 요약 가능한 next action이 있음

반대로 아래는 task 금지:

- 결과 보고
- 완료 요약
- 일회성 상태 브리핑
- 작업 결과를 설명하는 fact/decision

즉 결론은:

- **현재보다 훨씬 보수적으로 task를 만들자**: 동의
- **literal TODO만 task로 인정하자**: 너무 빡빡해서 반대

## My Final Position

우선순위는 이렇게 잡는 게 맞습니다.

1. task 생성 기준을 distill에서 크게 보수화
2. store 직전 deterministic normalization gate 추가
3. self-resolution은 positive/negative rule set으로 제한적으로 허용

즉:

- distill만 믿지 않는다
- regex 하나만 믿지도 않는다
- task는 지금보다 훨씬 적게 만든다

이 조합이 precision을 가장 크게 올리면서도, 실제 actionable task recall을 완전히 포기하지 않는 균형점이라고 봅니다.
