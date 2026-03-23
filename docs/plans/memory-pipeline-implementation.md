# Memory Pipeline 구현 계획

## 현재 완료
- `src/memory/embedding-provider.ts` — Ollama 임베딩 (qwen3-embedding:0.6b)
- `src/memory/memory-service.ts` — LanceDB 저장/검색
- `src/memory/index.ts` — 모듈 exports

## 구현 대상

### 1. Ollama Chat Provider
Ollama의 텍스트 생성 API를 위한 추상화.

```
위치: src/memory/chat-provider.ts

ChatProvider interface
├─ providerId, modelId
├─ healthCheck()
└─ chat(messages: ChatMessage[]): Promise<string>

OllamaChatProvider implements ChatProvider
├─ /api/chat 엔드포인트 사용
└─ 모델: qwen3:0.6b (distill용)
```

### 2. DistillService
메시지를 받아서 기억할 가치 판단 + 요약.

```
위치: src/memory/distill-service.ts

입력: {
  message: { speaker, content, timestamp }
  context: ChatMessage[]  // 슬라이딩 윈도우 (최근 10~20개)
}

출력: {
  shouldStore: boolean     // 기억할 가치가 있는가
  distilled: string        // 핵심 요약 (1-2문장)
  kind: MemoryKind         // fact | task | observation | feedback | ...
  priority: number         // 0-10
  topicKey?: string        // 주제 태그
}

내부:
- Ollama LLM에게 프롬프트 + 맥락 + 현재 메시지 전달
- JSON 구조화 응답 파싱
```

### 3. MemoryCollector (Discord 연동)
Discord 메시지 이벤트를 수신하여 자동 수집.

```
위치: src/memory/memory-collector.ts

역할:
- Discord messageCreate 이벤트 구독
- 채널/스레드별 슬라이딩 윈도우 관리 (Map<channelId, Message[]>)
- DistillService 호출
- shouldStore=true면 MemoryService.store() 호출

메타데이터:
- speaker: 'user' | 'claude' | 'codex'
- channelId, threadId (출처 추적)
```

### 4. MemoryUnit 스키마 확장

```diff
 export interface MemoryUnit {
   ...
+  speaker: 'user' | 'claude' | 'codex' | 'system';
+  channelId?: string;
+  threadId?: string;
 }
```

### 5. ConsolidationWorker (매일 정리)
하루 1회 기억 정리 — 해마의 수면 정리 역할.

```
위치: src/memory/consolidation-worker.ts

트리거: cron 또는 heartbeat 스케줄러
주기: 1일 1회 (유휴 시간)

작업:
1. decay 적용 — 오래된 기억 priority 일괄 감소
2. 중복 탐지 — 벡터 유사도 > 0.9 인 쌍 찾기
3. 병합/요약 — Claude Code 세션으로 배치 통합
4. 요약 저장 — kind='dialog_summary'로 새 기억 생성

Claude Code 세션 스폰:
- 단기 기억 목록을 파일로 내보내기
- 세션에서 읽고 요약/통합
- 결과를 파일로 출력
- 파이프라인이 읽어서 저장
```

### 6. CLI 테스트 도구

```
위치: src/cli/memory.ts

commands:
- sleep-code memory store "내용" --project=X --kind=fact
- sleep-code memory search "쿼리" --project=X --limit=5
- sleep-code memory list --project=X
- sleep-code memory stats
```

## 구현 순서 제안

```
Phase A: 즉시 distill 파이프라인
  1. Ollama Chat Provider
  2. DistillService
  3. MemoryUnit 스키마 확장 (speaker 필드)
  4. CLI 테스트 도구 (distill 단독 테스트)

Phase B: Discord 연동
  5. MemoryCollector (Discord 이벤트 → distill → 저장)
  6. 의지 스레드에서 기억 질의 기능

Phase C: 정리 heartbeat
  7. ConsolidationWorker (decay + 중복 병합 + 요약)
  8. 스케줄러 연동
```

## 미결 사항
- [ ] distill 프롬프트 설계 (한/영 대응)
- [ ] 슬라이딩 윈도우 크기 (10? 20?)
- [ ] 0.6B 모델의 distill 품질 검증 → 부족하면 모델 업그레이드
- [ ] decay 공식 (선형? 지수?)
- [ ] consolidation 시 Claude Code 세션 스폰 방식 구체화

---

## Codex Review (2026-03-03)

전체 방향은 타당합니다. 특히 `즉시 distill + 일일 consolidation` 분리는 비용/지연/품질 균형이 좋습니다.
다만 운영 안정성을 위해 아래 4가지는 계획에 명시적으로 추가하는 것을 권장합니다.

### 1) DistillService 프롬프트 설계 방향

권장: **2단 프롬프트 + 결정론적 가드**.

1. Pre-filter (코드 규칙)
- 너무 짧은 메시지, 이모지/리액션성 메시지, 단순 인사("ok", "thanks")는 LLM 호출 없이 skip
- 첨부파일/코드블록 포함 메시지는 우선순위 가중치만 주고 LLM으로 전달

2. Distill Prompt (LLM)
- 출력은 반드시 JSON 스키마로 제한:
  - `should_store: boolean`
  - `distilled: string` (최대 180자)
  - `kind: fact|task|observation|feedback|decision`
  - `priority: 0..10`
  - `topic_key: string`
  - `confidence: 0..1`
- rules:
  - 불확실하면 `should_store=false`
  - 이미 최근 memory와 중복이면 `should_store=false` + reason
  - 한국어/영어 혼합 입력은 원문 언어 유지

3. Post-validate (코드)
- JSON parse + zod/validator 검증
- 실패 시 재시도 1회, 이후 drop + `distill_parse_error` 카운트

### 2) `qwen3:0.6b` distill 품질 충분성

결론: **기본값으로 충분할 가능성이 높지만, 단독 신뢰는 위험**.

권장 운영 방식:
1. 품질 게이트 지표를 먼저 정의
- precision@store (저장된 것 중 실제 유의미 비율)
- duplicate rate (중복 저장 비율)
- missed-memory rate (사후 수동 라벨에서 누락 비율)

2. Shadow Eval 추가
- 1주일 샘플(예: 200건)을 `0.6b`와 상위 모델(예: qwen3 4b 또는 Claude batch) 동시 평가
- 기준 미달 시 모델 상향 또는 프롬프트 강화

3. 하이브리드 전략
- 기본은 0.6b
- `confidence < threshold` 또는 high-impact 메시지(마감/버그/결정)는 상위 모델 재평가 큐로 보냄

### 3) ConsolidationWorker의 Claude Code 세션 스폰 방식

현재 계획(파일 export -> 세션 요약 -> 파일 출력) 자체는 적절합니다.
다만 `ProcessManager.spawn()` 재사용보다 **전용 배치 러너**를 권장합니다.

이유:
- ProcessManager는 Discord 실시간 세션 라이프사이클에 맞춰져 있음
- consolidation은 비대화형 배치 작업이라 타임아웃/재시도/원자성 제어가 더 중요

권장 방식:
1. `src/memory/consolidation-runner.ts` 신설
2. job 디렉터리 생성: `~/.sleep-code/memory/jobs/{jobId}/`
3. `input.jsonl`, `instructions.md` 작성
4. Claude Code 비대화 실행 (artifact 제출 방식)
5. `output.json` 검증 후 `MemoryService` upsert
6. 성공 시 `job.done`, 실패 시 `job.error` + 재시도 백오프

필수 안전장치:
- `max_runtime_sec` (예: 300)
- 동시 consolidation 1개 제한
- idempotency key (`jobId`) 기반 중복 반영 방지

### 4) 빠진 부분 / 개선점

1. Memory Events 로그
- `memory_units`만으로는 변경 이력 추적이 어려움
- `memory_events`(append-only) 추가 권장: created/distilled/updated/merged/resolved/deleted

2. 중복 억제 계층
- store 전에 `topic_key + semantic similarity`로 near-duplicate 차단
- 동일 내용 반복 저장 방지 TTL(예: 24h)

3. 보존/삭제 정책
- `expiresAt`만 두지 말고 kind별 기본 TTL 필요
  - observation 30일, feedback 90일, fact/decision 무기한(수동 삭제까지)

4. 관측성(Observability)
- distill latency, parse error rate, store rate, consolidation merge rate, retrieval hit rate
- logger + 주기적 stats 커맨드(`memory stats`) 연결

5. Discord 연동 위치
- `discord-app.ts`의 `Events.MessageCreate` 핸들러에 collector 훅 추가하되,
  - 봇 메시지 제외
  - thread/session 매핑 가능한 메시지만 수집
  - routing 전/후 어떤 텍스트를 저장할지 명확화 필요 (권장: 정규화된 `cleanContent`)

6. 구현 순서 보정 (리스크 기준)
- Phase A-0: schema/events/metrics 먼저
- Phase A: chat-provider + distill-service + CLI eval
- Phase B: collector 연결 (read-only mode로 shadow 수집)
- Phase C: 실제 저장 활성화 + dedupe
- Phase D: consolidation worker 배포

### 최종 제안

지금 계획을 유지하되, 다음을 MVP 진입 조건으로 추가하는 것을 권장합니다.
1. Distill JSON validator + 재시도 1회
2. Duplicate suppression (`topic_key + vector sim`)
3. `memory_events` 도입
4. ConsolidationRunner 전용 배치 실행기
