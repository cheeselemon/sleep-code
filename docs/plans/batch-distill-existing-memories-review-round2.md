# Batch Distill Existing Memories Review Round 2

## Findings

### 1. High: "7일 전부"가 실제로 보장되지 않습니다

Files:

- `src/memory/batch-distill-runner.ts:326-341`
- `src/memory/memory-service.ts:360-380`

`getByProject(project, { limit: 500 })`는 `createdAt` 정렬 없이 먼저 500개를 자릅니다.  
그 다음에 JS에서 `createdAt >= cutoff` 필터를 거는 구조라서, 기록이 많은 프로젝트에서는 **최근 7일 기억이 500개 밖에 밀려나면 아예 못 들어옵니다**.

즉 현재 구현은 "프로젝트별 최근 7일 전부"가 아니라, **"정렬되지 않은 500개 샘플 안에서 최근 7일"**입니다.

### 2. High: 개수 제한 없는 7일 메모리 주입은 토큰 폭발 위험이 큽니다

Files:

- `src/memory/batch-distill-runner.ts:326-341`
- `src/memory/distill-service.ts:304-329`
- `src/memory/memory-config.ts:70`

기본 배치가 20개인데, 여기에:

- 메시지 20개 + context
- 프로젝트별 open task
- 프로젝트별 최근 7일 non-task memory 전부

를 같이 넣고 있습니다. 활발한 프로젝트에서 7일간 100건+ 기억이 쌓이면 prompt가 급격히 커집니다.

이건 safety cap 없이는 안전하지 않습니다.  
최소한 per-project 상한은 있어야 합니다.

### 3. Medium: fallback context 유실은 아직 그대로입니다

Files:

- `src/memory/distill-service.ts:240-241`
- `src/memory/distill-service.ts:342-351`

배치 파싱 실패나 호출 실패 시 `distillIndividually()`로 떨어지는데, 여기서는 여전히:

- `openTasks`
- `existingMemories`

를 넘기지 않습니다.

즉 prompt가 커져서 실패할수록, 새로 추가한 기능이 통째로 비활성화됩니다.

### 4. Medium: cross-project 오염은 프롬프트 수준에서는 많이 완화됐지만, 실행 단계 검증은 아직 없습니다

Files:

- `src/memory/distill-service.ts:273-329`
- `src/memory/batch-distill-runner.ts:448-458`

좋아진 점:

- message에 `project`가 들어감
- open task / existing memory를 프로젝트별로 그룹핑함
- same-project only 지시를 prompt에 넣음

남은 리스크:

- `resolveTaskIds`를 실제 적용할 때 project ownership 검증 없이 `updateStatus(taskId, 'resolved')`를 바로 호출합니다.

LLM 지시를 더 믿게 되었을 뿐, 서버 측 안전장치는 아직 없습니다.

### 5. Medium: 매 배치마다 프로젝트당 2번 조회하는 구조는 비용이 누적됩니다

Files:

- `src/memory/batch-distill-runner.ts:320-329`

현재 프로젝트마다:

1. `getByProject(... statuses:['open'], limit:100)`
2. `getByProject(... limit:500)`

를 매 batch마다 수행합니다.

프로젝트 수가 적으면 버틸 수 있지만, 활발한 채널에서 batch가 자주 돌면 비용이 선형으로 늘어납니다.  
지금 당장 치명적이라고 보진 않지만, 캐시나 tighter cap 없이 계속 두기엔 비효율적입니다.

## Conclusion

간결하게 말하면:

- 이전 리뷰의 **cross-project prompt 오염은 대부분 개선**됐습니다.
- 하지만 **fallback context 유실은 아직 미해결**입니다.
- 이번 변경의 새 핵심 리스크는:
  - `7일 전부`가 실제로는 보장되지 않는 쿼리 구조
  - `개수 제한 없음`으로 인한 prompt/token 폭발

## Recommendation

최소 수정으로 가려면 이 3개는 넣는 게 맞습니다.

1. per-project safety cap 추가
2. `getByProject(limit:500)` 기반 "7일 전부" 표현 수정 또는 조회 방식 재설계
3. fallback 시 `openTasks` / `existingMemories` 보존 또는 명시적 downgrade 로그 추가
