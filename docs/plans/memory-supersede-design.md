# Memory Supersede (대체) 메커니즘 설계 의견

## 목적
현재 메모리 파이프라인은 사실상 append-only라서, 같은 이벤트의 갱신(시간 변경, 이름 정정, 장소 확정)이 들어와도 오래된 기억이 함께 남습니다.  
목표는 최신성 보장 + 이력 추적을 동시에 달성하는 것입니다.

---

## 질문별 답변

### 1) Distill 단계에서 "기존 기억 업데이트" 감지 가능한가?
가능합니다. 단, LLM 단독 판정으로는 오탐/누락이 발생하므로 "LLM + 규칙 기반 게이트" 2단계가 안전합니다.

- LLM 출력 확장 (제안):
  - `memoryAction`: `create | update | skip`
  - `updateConfidence`: `0.0 ~ 1.0`
  - `changeType`: `correction | refinement | reschedule | location_update | contact_update | other`
  - `updateHints`: `{ topicKeyHint, anchorTerms[], changedFields[] }`
- 규칙 게이트:
  - 명시적 업데이트 신호 단어(예: `정정`, `바뀜`, `확정`, `변경`, `->`, `에서 ... 로`) 탐지
  - 숫자/시간/이름/장소와 같은 concrete field 변화 탐지
  - `updateConfidence >= threshold` 조건(예: 0.8)

결론: 감지는 가능하지만, LLM 출력을 그대로 신뢰하지 말고 규칙 검증을 붙여야 실사용 안정성이 나옵니다.

### 2) 감지 후 기존 기억을 어떻게 찾고 대체하는가?
`topicKey` 단독은 파편화 이슈가 있으므로, 후보 검색은 다중 신호 결합이 필요합니다.

- 후보군 수집:
  - 같은 `project`
  - 활성 상태만 대상 (`open`, `in_progress`, `snoozed`)
  - 시간창 우선 (예: 최근 30일, personal-memory는 90일까지 옵션)
- 점수 계산 (blended):
  - `topic score` (같은 topicKey 또는 alias 매칭)
  - `vector score` (코사인)
  - `anchor term overlap` (핵심 엔티티: 인명, 장소, 이메일, 날짜/시간)
  - `kind compatibility` (task/decision/fact 간 호환 규칙)
- 후보 선택:
  - 최고점이 임계치 이상이면 supersede 대상
  - 임계치 미만이면 신규 생성(create)로 처리

추천 초기값:
- `topicKey exact`: +0.35
- `vector`: +0.35
- `anchor overlap`: +0.20
- `kind compatibility`: +0.10

### 3) 대체 시 이전 기억 삭제 vs `superseded` 보존?
삭제보다 `status='superseded'` 보존을 권장합니다.

이유:
- 잘못된 대체(오탐) 롤백 가능
- 변경 이력 추적 가능 (언제/왜 바뀌었는지)
- 디버깅 및 사용자 신뢰도 높음

스키마 최소 확장 제안:
- `MemoryStatus`에 `superseded` 추가
- 링크 필드:
  - `supersedesId` (신규 기억 -> 대체한 이전 기억)
  - `supersededById` (이전 기억 -> 자신을 대체한 신규 기억)
  - `supersededAt`

조회 기본 정책:
- 검색/리스트 기본값은 `superseded` 제외
- `includeSuperseded=true` 옵션으로 이력 조회 가능

### 4) qwen2.5:7b가 업데이트 감지를 정확히 할 수 있는가?
명시적 케이스는 잘 잡지만, 미묘한 정정(이름 1글자 교정, 간접적 시간 변경)은 단독 정확도가 충분하지 않을 수 있습니다.

실무 권장:
- qwen2.5:7b는 "초안 판정기"로 사용
- 최종 적용은 규칙 기반 게이트 + 후보 점수 검증으로 확정
- low confidence는 create로 fallback (보수적 정책)

---

## 제안 아키텍처 (안전한 단계적 도입)

### Phase A: Non-destructive supersede
1. distill 결과에 `memoryAction/updateConfidence/updateHints` 추가
2. `findSupersedeCandidate()` 구현 (다중 신호 스코어)
3. `update` 판정 시:
   - 신규 메모리 저장
   - 기존 메모리 상태를 `superseded`로 변경
   - 양방향 link 필드 업데이트
4. 검색 기본에서 `superseded` 제외

장점: 잘못 판정돼도 데이터 손실 없음.

### Phase B: Topic alias 정규화
- `memory-management` vs `duplicate-threshold` 같은 파편화 완화
- alias map 또는 canonical topic dictionary 도입

### Phase C: 사용자 제어
- 수동 명령:
  - `memory supersede <oldId> <newId>`
  - `memory unsupersede <id>`
- 운영 중 오탐 수습 경로 제공

---

## 구현 포인트 (현재 코드 기준)

- `src/memory/distill-service.ts`
  - DistillResult 확장 (`memoryAction`, `updateConfidence`, `updateHints`)
  - 프롬프트에 update/correction 판정 규칙 추가

- `src/memory/memory-collector.ts`
  - `storeIfNew` 직전 supersede 분기 로직 추가
  - 낮은 confidence는 기존 create 흐름으로 fallback

- `src/memory/memory-service.ts`
  - `findSupersedeCandidate(...)`
  - `markSuperseded(oldId, newId)`
  - `search/getByProject`에서 `superseded` 기본 제외 필터 옵션

- `src/mcp/memory-server.ts`, `src/cli/memory.ts`
  - supersede 이력 조회/복구 커맨드 및 옵션 추가

---

## 운영 정책 (권장)

- 기본 정책: "확실할 때만 supersede, 애매하면 create"
- 대체는 항상 soft-delete(`superseded`) 방식
- 주기적으로 `superseded` 비율과 오탐률 모니터링

---

## 결론

1. Distill 단계 업데이트 감지는 가능하다. 다만 LLM 단독은 위험하므로 규칙 게이트가 필요하다.  
2. 기존 기억 탐색은 `topicKey + vector + anchor terms + time window`의 다중 신호가 필요하다.  
3. 삭제 대신 `superseded` 상태 보존이 맞다.  
4. qwen2.5:7b는 보조 판정기로 충분하지만, 최종 결정권을 단독으로 주면 정확도 리스크가 있다.
