# Memory Task Lifecycle Report

## Scope
- Read: `docs/internal/plans/memory-task-lifecycle-discussion.md`
- Checked code:
  - `src/memory/distill-service.ts`
  - `src/memory/consolidation-service.ts`
  - `src/memory/daily-digest.ts`
  - `src/memory/memory-service.ts`
  - `src/memory/memory-collector.ts`

## Executive Summary

이 문제의 1차 근본 원인은 `distill -> store` 구간에서 "완료 보고 / 일회성 지시 / 이미 끝난 작업"이 `kind='task'`, `status='open'`으로 저장되는 것입니다.

2차 원인은 `consolidation`의 auto-resolution이 완료 증거를 `decision|fact`로만 인정해서, 실제로는 "완료" 성격의 메모리가 `task`나 `observation`으로 들어오면 기존 task를 닫지 못한다는 점입니다.

`daily-digest`는 이 오염된 `open task`를 거의 그대로 읽어서 `Action Required` / `Stalled`에 올리므로, digest가 망가지는 것은 결과이지 원인은 아닙니다.

## What The Code Confirms

### 1. New tasks are always born as `open`

`src/memory/memory-service.ts:164-187`

- 모든 새 메모리는 `store()`에서 `status: 'open'`으로 생성됩니다.
- 즉 distill이 완료 보고를 `task`로 잘못 분류하면, 저장 순간부터 열린 할 일로 굳어집니다.
- 저장 단계에는 "이 task가 이미 완료형 문장인지"를 검증하는 로직이 없습니다.

### 2. Distill prompt says to skip completed one-off tasks, but parser does not enforce it

`src/memory/distill-service.ts:66-76`
`src/memory/distill-service.ts:400-475`

- 프롬프트는 `"npm install 완료", "파일 생성함", "테스트 통과"` 같은 완료형 일회성 작업은 skip하라고 지시합니다.
- 하지만 실제 파서/검증은:
  - vague한지
  - CJK 오류인지
  - `kind`가 enum에 들어가는지
  - priority 범위가 맞는지
  정도만 봅니다.
- 즉 LLM이 concrete한 완료 보고를 `kind='task'`로 내면 그대로 통과합니다.

중요한 부작용:
- `isVagueText()`는 숫자, 파일명, 경로, 날짜 등 concrete signal이 있으면 vague가 아니라고 봅니다.
- 그래서 `"모든 프로젝트 리태깅 완료... 총 412건"` 같은 완료 보고는 오히려 더 쉽게 통과합니다.

### 3. Consolidation only resolves tasks from `decision|fact` evidence

`src/memory/consolidation-service.ts:312-400`

- Phase 4는 open task를 닫기 위해 completion evidence를 찾지만, 인정하는 증거 타입이 매우 좁습니다.
- Strategy 1:
  - 같은 `topicKey`
  - newer
  - `kind === 'decision' || kind === 'fact'`
  - completion regex match
- Strategy 2(vector fallback):
  - 역시 `decision|fact`만 인정
- 따라서 완료 보고가 `task`나 `observation`으로 저장되면, 문장에 `완료/구현/해결`이 들어 있어도 증거로 사용되지 않습니다.

이건 discussion 문서의 Example 1, 2를 그대로 설명합니다.

### 4. Consolidation has no self-healing for completion-like task text

`src/memory/consolidation-service.ts:329-395`

- 현재는 "다른 메모리"를 completion evidence로 찾아야만 task를 `resolved`로 바꿉니다.
- task 자신의 텍스트가 이미 완료 보고여도 닫지 않습니다.
- 예: `"리태깅 완료"`, `"112건 삭제 완료"`, `"구현 끝남"` 같은 task는 self-resolution 없이 영구 open으로 남을 수 있습니다.

### 5. Lifecycle expiry is too weak to protect the digest

`src/memory/consolidation-service.ts:261-310`

- low-priority task만 7일 후 expire
- 나머지 task는 30일 지나야 stale expire

즉 high-priority로 잘못 저장된 가짜 task는 최대 30일 동안 digest를 오염시킬 수 있습니다.

### 6. Daily digest trusts `open task` status almost completely

`src/memory/daily-digest.ts:189-208`

- `Action Required`: `kind='task' && status='open' && priority>=7 && 최근 7일`
- `Stalled`: `kind='task' && status='open' && priority>=5 && 3~30일`

별도의 sanity check가 없어서 upstream이 잘못 만든 open task가 그대로 노출됩니다.

## Root Cause Ranking

### Primary root cause

`distill`이 "미완료 작업"과 "완료 보고 / 일회성 지시 / 작업 결과 요약"을 제대로 구분하지 못하는데, 그 결과를 `memory-service`가 무조건 `task/open`으로 저장합니다.

즉 lifecycle semantics가 ingest 단계에서 이미 깨집니다.

### Secondary root cause

`consolidation`이 잘못 저장된 task를 회복하는 능력이 약합니다.

- completion evidence kind를 `decision|fact`로 제한
- self-resolution 부재
- topicKey mismatch에 취약

그래서 ingress 오류가 digest까지 전파됩니다.

### Tertiary factor

`daily-digest`가 user-facing 방어선을 거의 두지 않습니다.

이건 원인은 아니지만, "나쁜 task가 들어오면 바로 briefing이 망가지는" 증폭기 역할을 합니다.

## Answer To The Discussion Questions

### 1. Real root cause: distill quality or resolution logic?

둘 다지만, 우선순위는:

1. ingest semantics failure (`distill + store`)
2. cleanup/recovery weakness (`consolidation`)
3. user-facing lack of defensive filtering (`daily-digest`)

즉 "distill이 나쁘다"보다 더 정확한 표현은:
"task lifecycle state를 ingest에서 추출하지 않고, 잘못 분류된 task를 downstream이 복구하지 못한다."

### 2. Fix distill, consolidation, or both?

둘 다 고쳐야 합니다.

- distill만 고치면 기존 DB 오염이 남습니다.
- consolidation만 고치면 새로 들어오는 bad task가 계속 생깁니다.

권장 순서:

1. distill/store ingress 차단
2. consolidation backfill cleanup
3. daily-digest defensive filter

### 3. Is the 5-bucket digest format the issue?

아니요. 현재 문제의 핵심은 bucket 설계보다 input quality입니다.

지금은 bucket이 잘못이라기보다, `Action Required`에 들어오면 안 되는 항목이 `open task`로 남아 있는 게 문제입니다.

### 4. Should tasks have TTL by default?

보조책으로는 유효하지만 근본 해결은 아닙니다.

- TTL만 넣으면 "완료된 task가 며칠 동안 계속 뜨는 문제"는 남습니다.
- 특히 digest는 최근 7일 / 30일 창을 쓰므로, TTL만으로는 이미 체감이 나쁩니다.

TTL은 cleanup 보조수단으로 쓰고, 주 해결책은 ingest classification + resolution 강화여야 합니다.

### 5. Smarter linking beyond topicKey/vector?

필요합니다. 다만 지금은 그 전에 해야 할 일이 있습니다.

먼저:
- completion-like text recognition
- self-resolution
- evidence kind 확대

그 다음:
- anchor terms 기반 linking
- canonical topic alias
- task/result pair matching

## Recommended Fix Plan

### Phase 1. Block bad tasks at ingress

Target: `src/memory/distill-service.ts`, `src/memory/memory-collector.ts`, `src/memory/batch-distill-runner.ts`, `src/memory/memory-service.ts`

권장 변경:

1. `task`를 "future actionable unfinished work"로 더 엄격히 정의
2. distill post-parse rule 추가
   - if `kind === 'task'` and text matches completion/report patterns:
     - either coerce to `fact`
     - or skip storage
3. 일회성 imperative/instruction 패턴 차단
   - 예: `재시작해줘`, `테스트 진행`, `확인 부탁`, `수정해라`
   - 장기 가치가 없는 경우 skip
4. `store()`가 initial status를 받을 수 있게 확장하거나
   - 최소한 completion-like task는 `resolved`로 저장 가능하게 함

가장 중요한 포인트:
`kind='task'`면 곧바로 `status='open'`이 되는 현재 결합을 약화해야 합니다.

### Phase 2. Make consolidation recover bad historical data

Target: `src/memory/consolidation-service.ts`

권장 변경:

1. self-resolution 추가
   - task 자체 텍스트가 completion-like면 즉시 `resolved`
2. evidence kind 확대
   - `decision|fact`만 보지 말고, completion-like `task|observation`도 증거로 인정
3. completion detector를 공용 helper로 분리
   - 단순 regex 하나보다 report-style patterns 포함
4. topicKey mismatch 보완
   - vector fallback 유지
   - 가능하면 anchor term overlap 추가

실무적으로는 이 단계만 해도 기존 DB에 쌓인 open task 상당수를 정리할 수 있습니다.

### Phase 3. Add a defensive digest filter

Target: `src/memory/daily-digest.ts`

권장 변경:

1. `Action Required` / `Stalled` 후보에서 completion-like text 제외
2. 가능하면 `resolved|expired|superseded`뿐 아니라
   "open인데 텍스트상 완료 보고"인 항목도 skip

이 단계는 upstream 버그가 다시 생겨도 digest 품질을 방어합니다.

## Concrete Recommendation

가장 효과적인 최소 세트는 아래 3개입니다.

1. `distill-service`에 `task` completion-rule gate 추가
2. `consolidation-service`에 self-resolution + evidence kind 확대 추가
3. `daily-digest`에 completion-like open task 필터 추가

이 3개를 같이 넣어야:
- 신규 오염 차단
- 기존 오염 정리
- 사용자 노출 방어

## Bottom Line

문제의 본질은 "완료된 작업이 계속 open으로 남는다"가 아니라,
"현재 시스템이 task의 lifecycle state를 ingest 시점에 제대로 표현하지 못하고, 이후 단계도 그 오류를 충분히 복구하지 못한다"입니다.

따라서 해결도 단일 포인트 수정이 아니라:

- ingress에서 bad task 생성 차단
- consolidation에서 historical cleanup 수행
- digest에서 마지막 방어선 추가

이 3단 구조로 가는 것이 맞습니다.
