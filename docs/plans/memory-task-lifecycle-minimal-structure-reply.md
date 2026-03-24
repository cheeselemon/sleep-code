# Memory Task Lifecycle Minimal Structure Reply

## Bottom Line

초안의 방향은 맞습니다.  
`task-rules.ts` 같은 **작은 규칙 모듈을 먼저 만드는 것**이 이번 제약 조건에 가장 잘 맞습니다.

다만 **"호출 1곳만 수정"은 부족**합니다.  
현재 원인이 2개이기 때문에, 최소 구조를 유지하더라도 **호출은 2곳**이어야 합니다.

1. 저장 시점: completion-like task가 `task/open`으로 들어오는 문제 차단
2. consolidation 시점: 이미 DB에 쌓인 bad open task 정리

## What I Agree With

- 파일 1개로 규칙을 모으는 것: 좋음
- 나중에 rule을 확장할 seam을 먼저 만드는 것: 좋음
- 지금은 over-engineering 피하고 작은 구조부터 넣는 것: 맞음

즉 `src/memory/task-rules.ts`는 이 문제를 풀기 위한 적절한 "작은 확장 포인트"입니다.

## What I Would Change

### 1. Call site는 1곳이 아니라 2곳이어야 함

초안대로 consolidation self-resolution에만 넣으면:

- 기존 bad task는 정리될 수 있음
- 하지만 새 completion report는 여전히 `task/open`으로 저장됨

즉 증상은 줄어들어도 root cause 1은 그대로 남습니다.

반대로 store 쪽에만 넣으면:

- 새 오염은 줄어듦
- 하지만 기존 DB 오염은 digest에 계속 남음

그래서 최소 구조를 유지하더라도 아래 2곳은 같이 건드려야 합니다.

1. `src/memory/memory-service.ts`
   - `store()`에서 `kind === 'task' && isCompletionLikeTask(text)`면 `kind = 'fact'`로 coercion
2. `src/memory/consolidation-service.ts`
   - Phase 4 self-resolution에서 `isCompletionLikeTask(record.text)`면 `resolved`

이렇게 해야 두 원인을 동시에 막습니다.

### 2. store 쪽은 status까지 건드리지 않아도 됨

이번 최소 변경에서는 `status='resolved'`까지 밀어 넣지 않아도 됩니다.

왜냐면 immediate pain은:
- completion report가 `task/open`으로 저장되는 것
- digest가 `open task`를 읽는 것

따라서 store 시점에서:

- `task -> fact` coercion만 해도 digest 오염은 막을 수 있습니다

이건 API 변경을 최소화합니다.

즉 지금은:

- `kind='task'` + completion-like → `kind='fact'`

까지만 해도 충분히 값이 큽니다.

나중에 필요하면 `resolved` status나 richer classification을 붙이면 됩니다.

### 3. 함수 이름은 "강한 completion" 의미가 드러나야 함

단순 `isCompletionLikeTask()`도 나쁘진 않지만, 의미를 조금 더 보수적으로 드러내는 이름이 좋습니다.

예:

- `isStrongCompletionLikeTask(text)`
- `isResolvedReportTask(text)`

이유:

- `"완료 후 Y 해야 함"` 같은 애매한 문장을 잡지 않겠다는 의도가 이름에 드러남
- future rule 추가 때도 "이 함수는 강한 신호만 본다"는 경계가 유지됨

그래도 이름을 바꾸기 싫다면, 구현 주석으로라도 "strong-positive only"를 박아두는 게 좋습니다.

## Minimal Recommended Design

### New file

- `src/memory/task-rules.ts`

### Export

- 함수 1개:
  - `isCompletionLikeTask(text: string): boolean`

### Initial implementation policy

이 함수는 **strong-positive only** 정책으로 간다.

즉:

- 완료/해결/반영/삭제 완료/총 N건 처리 같은 **결과 보고형 표현**만 true
- future/conditional 냄새가 나면 false
- 애매하면 false

이렇게 해야 false positive closure를 피할 수 있습니다.

## Why This Is The Right "Hoe"

이 구조가 좋은 이유는:

1. 지금은 파일 1개, 함수 1개로 시작 가능
2. 나중에 rule을 늘릴 때 수정 위치가 명확함
3. 더 확장하고 싶으면 나중에 이 파일 내부만 바꿔서:
   - richer detector
   - enum return
   - explanation metadata
   로 진화시킬 수 있음

즉 지금은 작지만, seam은 미래 확장에 맞게 잡는 방식입니다.

## Final Recommendation

초안의 핵심 아이디어는 채택하는 게 맞습니다.  
다만 최종안은 이렇게 수정하는 걸 권장합니다.

1. `src/memory/task-rules.ts` 추가
2. `isCompletionLikeTask(text)` 하나 export
3. 호출은 1곳이 아니라 2곳
   - `MemoryService.store()`에서 `task -> fact` coercion
   - `ConsolidationService` self-resolution에서 open task resolve

한 줄 요약:

**"파일 1개, 함수 1개"는 맞지만 "호출 1곳"은 부족하다. 최소한 `store`와 `consolidation` 두 군데는 걸어야 현재 문제를 구조적으로 닫을 수 있다.**
