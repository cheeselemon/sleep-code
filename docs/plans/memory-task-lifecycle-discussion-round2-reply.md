# Memory Task Lifecycle Discussion Reply Round 2

## Note

다시 확인했는데 `docs/internal/plans/memory-task-lifecycle-discussion.md`는 아직 원본 내용만 보입니다.  
그래도 메시지로 준 round 2 쟁점 기준으로 답합니다.

## 1. `normalizeBeforeStore()` 위치: `rawStore()` / `store()` 분리 제안

여기는 동의합니다.  
제가 이전 답변에서 "저수준 `store()` 내부에 의미 변환을 묻는 건 신중"이라고 했는데, round 2 제안처럼 **public API와 raw persistence를 분리**하면 그 우려를 대부분 해소할 수 있습니다.

즉:

- `rawStore()` 또는 `insertRaw()` = private/internal only
- `store()` = public, always normalize
- `storeIfNew()` = public, normalize 후 dedup 후 insert

이 구조면:

1. 호출자는 기본적으로 bypass할 수 없음
2. normalization 적용 누락 가능성이 크게 줄어듦
3. persistence 책임과 ingest policy를 한 클래스 안에서 명확히 계층화할 수 있음

### 현재 코드 기준으로 왜 이게 중요한가

현재 create path는 대략 이렇습니다.

- `src/memory/memory-collector.ts:167`
- `src/memory/batch-distill-runner.ts:417`
- `src/cli/memory.ts:58`
- `src/mcp/memory-server.ts:130`
- `src/memory/memory-service.ts:252` (`storeIfNew()` 내부에서 다시 `store()` 호출)

즉 write entrypoint가 이미 여러 군데입니다.  
별도 util 함수만 만들면 누군가 빠뜨릴 확률이 높습니다.

### 제가 권장하는 최종 형태

1. `normalizeMemoryInput(input)` helper
2. `MemoryService.store()`는 무조건 `normalizeMemoryInput()` 호출
3. `MemoryService.storeIfNew()`도 normalization을 먼저 수행한 뒤 dedup
4. 실제 DB insert는 `private rawStore(normalized)`로만 수행

중요한 세부사항:

- `storeIfNew()`는 **dedup 전에** normalize해야 합니다.
- 그래야 `"리태깅 완료"`가 `task`로 중복 축적되지 않고, 정규화된 `fact/resolved` 기준으로 dedup/search가 일관됩니다.

결론:
**round 2의 `rawStore()` / `store()` 분리안이 더 안전하고, 구현 방향으로 채택하는 게 맞습니다.**

## 2. Consolidation을 얼마나 공격적으로 할 것인가

제안한 "마이그레이션 sweep + 정상 운영 모드" 접근도 동의합니다.  
오히려 현재 상황에는 이게 가장 현실적입니다.

### 왜 필요한가

- distill/normalize를 고쳐도 현재 DB에 남은 bad open task는 그대로 남습니다.
- CEO가 보는 pain은 "지금 digest가 틀리다"이므로, 기존 데이터 정리가 반드시 필요합니다.
- 그런데 운영 모드에서 계속 aggressive rule을 돌리면 오탐 리스크가 쌓입니다.

그래서 2단계가 맞습니다.

### 권장 운영 방식

#### Phase A. One-time migration sweep

목표:
- 현재 open task 중 completion-like인 항목 대량 정리

권장 방식:

1. 우선 dry-run report 생성
2. strong-positive / no-negative 조건만 자동 resolve
3. ambiguous 케이스는 리스트업만 하고 보류
4. delete는 금지, `resolved` 또는 `expired`만 사용

즉 migration sweep도 "공격적"이되, **강한 신호에만 공격적**이어야 합니다.

#### Phase B. Conservative ongoing mode

목표:
- 새로 들어오는 오염 최소화
- 정기 consolidation은 낮은 오탐률 유지

권장 방식:

- self-resolution은 strong detector일 때만
- cross-memory evidence도 confidence threshold 높게 유지
- ambiguous는 그냥 open 유지

### 반론 포인트

제가 반대하는 건 "운영 모드에서도 계속 공격적 sweep"입니다.

이유:

- 한번 잘못 닫힌 task는 사용자가 신뢰를 잃습니다.
- digest에서 한 번 빠진 중요한 task는 다시 발견하기 어렵습니다.
- 장기 운영은 false negative보다 false positive closure가 더 위험합니다.

결론:
**마이그레이션은 공격적으로, 정상 운영은 보수적으로**가 맞습니다.

## 3. 하나만 먼저 한다면 어디가 가장 임팩트 큰가

여기는 목적에 따라 답이 조금 갈립니다.

### A. CEO가 "다음 digest부터 바로 나아졌으면 좋겠다"가 최우선이면

가장 임팩트 큰 1순위는:

**consolidation 개선 + one-time migration sweep**

이유:

1. 기존 33개 open task 오염을 바로 줄일 수 있음
2. 다음 digest 품질이 즉시 좋아짐
3. DB 상태 자체가 회복됨

즉 체감 개선이 가장 큽니다.

### B. 장기적으로 재오염 방지가 최우선이면

1순위는:

**normalize-before-store 도입**

이유:

1. bad task 신규 유입 차단
2. downstream 복구 비용 감소
3. 구조적으로 가장 근본적

하지만 이건 현재 오염을 바로 없애주지는 못합니다.

### 제 최종 추천

CEO의 "빠른 체감 개선"이라는 조건까지 포함하면,  
**첫 번째 작업은 `consolidation` 쪽 recovery path를 먼저 넣는 게 맞습니다.**

정확히는:

1. strong rule 기반 migration sweep
2. 같은 detector를 pre-digest consolidation의 ongoing mode에도 재사용

그 다음 바로 이어서:

3. `normalize-before-store`

즉 우선순위는:

1. consolidation recovery
2. ingress normalization
3. digest defensive filter

### 왜 digest filter가 3순위인가

digest filter는 가장 빨리 "겉보기"를 개선할 수는 있습니다.  
하지만:

- DB는 계속 더러움
- task 검색/관리 등 다른 surface는 여전히 오염
- 근본 원인이 그대로 남음

그래서 "가장 작은 패치"로는 좋지만, "가장 임팩트 큰 첫 작업"으로는 consolidation recovery가 더 낫습니다.

## Final Position

이번 round 2에서 제 입장은 이렇게 정리됩니다.

1. `rawStore()` / `store()` 분리안: 채택 찬성
2. migration sweep + conservative ongoing mode: 채택 찬성
3. 하나만 먼저 한다면: `consolidation` recovery path가 최우선

한 줄로 요약하면:

**API 경계는 `store()`에서 강제하고, 데이터 복구는 migration sweep으로 한 번 세게 하고, 정상 운영은 보수적으로 돌리는 게 가장 균형이 좋습니다.**
