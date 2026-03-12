# Memory Supersede 메커니즘 구현 계획서

## 배경

메모리가 append-only라서, 같은 이벤트의 갱신(시간 변경, 이름 정정, 장소 확정)이 들어와도 오래된 기억이 함께 남는 문제.
Codex 설계안(`docs/plans/memory-supersede-design.md`) 기반으로 구현.

**핵심 원칙:** "확실할 때만 supersede, 애매하면 create" + soft-delete(superseded 상태 보존)

---

## Phase A: Non-destructive Supersede (핵심)

### A1. 스키마 확장

**파일:** `src/memory/memory-service.ts`

1. `MemoryStatus`에 `'superseded'` 추가:
```typescript
export type MemoryStatus = 'open' | 'in_progress' | 'snoozed' | 'resolved' | 'expired' | 'superseded';
```

2. `MemoryUnit` 인터페이스에 supersede 링크 필드 추가:
```typescript
export interface MemoryUnit {
  // ... existing fields ...
  supersedesId?: string;     // 신규 기억 → 대체한 이전 기억
  supersededById?: string;   // 이전 기억 → 자신을 대체한 신규 기억
  supersededAt?: string;     // ISO timestamp
}
```

3. `mapRowToUnit()` 확장:
```typescript
supersedesId: (row.supersedesId as string) || undefined,
supersededById: (row.supersededById as string) || undefined,
supersededAt: (row.supersededAt as string) || undefined,
```

4. `store()` 메서드에서 새 필드 초기값:
```typescript
supersedesId: options.supersedesId ?? '',
supersededById: '',
supersededAt: '',
```

5. `store()` options 인터페이스 확장:
```typescript
supersedesId?: string;  // 이 기억이 대체하는 이전 기억 ID
```

### A2. Supersede 핵심 메서드

**파일:** `src/memory/memory-service.ts`

1. `markSuperseded(oldId, newId)` 메서드 추가:
```typescript
async markSuperseded(oldId: string, newId: string): Promise<void> {
  if (!this.table) return;
  const now = new Date().toISOString();
  // 이전 기억: superseded 상태로 변경 + 링크
  await this.table.update({
    where: `id = '${escapeSqlLiteral(oldId)}'`,
    values: {
      status: 'superseded' as MemoryStatus,
      supersededById: newId,
      supersededAt: now,
      updatedAt: now,
    },
  });
  // 신규 기억: supersedesId 링크
  await this.table.update({
    where: `id = '${escapeSqlLiteral(newId)}'`,
    values: {
      supersedesId: oldId,
      updatedAt: now,
    },
  });
  log.info({ oldId, newId }, 'Marked memory as superseded');
}
```

2. `findSupersedeCandidate()` 메서드 추가:
```typescript
async findSupersedeCandidate(
  text: string,
  vector: number[],
  options: {
    project: string;
    topicKey?: string;
    anchorTerms?: string[];
    kind?: MemoryKind;
  },
): Promise<{ id: string; score: number } | null>
```

**다중 신호 스코어링:**
- `topicKey exact match`: +0.35
- `vector cosine similarity`: +0.35 (0.7 이상일 때만 기여)
- `anchor term overlap`: +0.20
- `kind compatibility`: +0.10

**후보 필터:**
- 같은 project
- 활성 상태만 (`open`, `in_progress`, `snoozed`) — superseded 제외
- 최근 30일 이내 (`createdAt` 기준)

**임계치:** 최종 score ≥ 0.65면 supersede 대상, 미만이면 null 반환

**구현 접근:**
```typescript
async findSupersedeCandidate(...): Promise<{ id: string; score: number } | null> {
  if (!this.table) return null;

  // 1. vector 후보 검색 (cosine 0.7+, limit 10)
  const vectorCandidates = await this.searchByVector(vector, {
    project: options.project,
    limit: 10,
    minScore: 0.7,
  });

  // 2. superseded 상태 제외 + 30일 필터
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const activeCandidates = vectorCandidates.filter(
    (c) => c.status !== 'superseded' && c.createdAt >= thirtyDaysAgo
  );

  if (activeCandidates.length === 0) return null;

  // 3. 각 후보에 blended score 계산
  const queryKeywords = this.extractKeywords(text);
  const anchorTerms = options.anchorTerms ?? [];

  let best: { id: string; score: number } | null = null;

  for (const candidate of activeCandidates) {
    let score = 0;

    // topicKey exact match: +0.35
    if (options.topicKey && candidate.topicKey === options.topicKey) {
      score += 0.35;
    }

    // vector similarity: +0.35 (scaled from 0.7~1.0 → 0~0.35)
    const vecContrib = Math.max(0, (candidate.score - 0.7) / 0.3) * 0.35;
    score += vecContrib;

    // anchor term overlap: +0.20
    if (anchorTerms.length > 0) {
      const candidateText = candidate.text.toLowerCase();
      const matches = anchorTerms.filter((t) => candidateText.includes(t.toLowerCase()));
      score += (matches.length / anchorTerms.length) * 0.20;
    }

    // kind compatibility: +0.10
    if (options.kind && candidate.kind === options.kind) {
      score += 0.10;
    }

    if (!best || score > best.score) {
      best = { id: candidate.id, score };
    }
  }

  // 임계치 0.65
  return best && best.score >= 0.65 ? best : null;
}
```

### A3. Distill 확장 — 업데이트 감지

**파일:** `src/memory/distill-service.ts`

1. `DistillResult` 확장:
```typescript
export interface DistillResult {
  shouldStore: boolean;
  distilled: string;
  kind: MemoryKind;
  priority: number;
  topicKey: string;
  speaker?: string;
  // ── Supersede fields ──
  memoryAction?: 'create' | 'update';    // LLM 판정
  updateConfidence?: number;              // 0.0 ~ 1.0
  anchorTerms?: string[];                 // 핵심 엔티티 (인명, 장소, 날짜, 시간)
}
```

2. SYSTEM_PROMPT 확장 — JSON 스키마에 3개 필드 추가:
```
- memoryAction: "create" for new info, "update" if this CORRECTS/CHANGES/RESCHEDULES existing info
  - Update signals: "→", "에서 ... 로", "변경", "정정", "바뀜", "확정", "취소", explicit time/name/place changes
  - If unsure, default to "create"
- updateConfidence: 0.0-1.0 (how confident this is an update vs new info)
- anchorTerms: array of key entities (names, places, dates, times, amounts) in the message
```

JSON 스키마 예시:
```json
{"shouldStore": true, "distilled": "...", "kind": "decision", "priority": 7, "topicKey": "meeting-schedule", "speaker": "user", "memoryAction": "update", "updateConfidence": 0.9, "anchorTerms": ["김대리", "3/15", "2시"]}
```

3. `parseResponse()` 확장 — 신규 필드 파싱 + 규칙 게이트:
```typescript
// Parse new fields
const memoryAction = parsed.memoryAction === 'update' ? 'update' : 'create';
const updateConfidence = typeof parsed.updateConfidence === 'number'
  ? Math.max(0, Math.min(1, parsed.updateConfidence)) : 0;
const anchorTerms = Array.isArray(parsed.anchorTerms)
  ? parsed.anchorTerms.filter((t: unknown) => typeof t === 'string') : [];

// Rule gate: only trust "update" if confidence >= 0.8 AND text has update signals
let validatedAction: 'create' | 'update' = 'create';
if (memoryAction === 'update' && updateConfidence >= 0.8) {
  const updateSignals = /[→→]|에서\s.*로|변경|정정|바뀜|확정|취소|changed|updated|rescheduled|corrected/i;
  if (updateSignals.test(parsed.distilled) || updateConfidence >= 0.95) {
    validatedAction = 'update';
  }
}
```

### A4. Collector 통합 — supersede 분기

**파일:** `src/memory/memory-collector.ts`

`distillAndStore()` 메서드 수정 — `storeIfNew()` 호출 전에 supersede 분기:

```typescript
// After distill, before store:
if (result.memoryAction === 'update' && result.anchorTerms?.length) {
  // Embed for candidate search
  // (storeIfNew will embed anyway, so we grab the vector here for reuse)
  const vector = await this.memory.embedForSearch(result.distilled);

  const candidate = await this.memory.findSupersedeCandidate(
    result.distilled,
    vector,
    {
      project,
      topicKey: result.topicKey,
      anchorTerms: result.anchorTerms,
      kind: result.kind as MemoryKind,
    },
  );

  if (candidate) {
    // Store new memory, then mark old as superseded
    const newId = await this.memory.store(result.distilled, {
      project,
      kind: result.kind as MemoryKind,
      source: 'session',
      speaker: (result.speaker as MemorySpeaker) ?? msg.speaker,
      priority: result.priority,
      topicKey: result.topicKey,
      channelId: msg.channelId,
      threadId: msg.threadId,
      vector,
      supersedesId: candidate.id,
    });
    await this.memory.markSuperseded(candidate.id, newId);
    log.info(
      { newId, oldId: candidate.id, score: candidate.score, topic: result.topicKey },
      'Memory superseded',
    );
    return;
  }
}

// Fallback: normal create flow
const id = await this.storeIfNew(result.distilled, { ... });
```

**NOTE:** `MemoryService`에 `embedForSearch(text)` 헬퍼 추가 필요 (embedding.embedSingle 위임):
```typescript
async embedForSearch(text: string): Promise<number[]> {
  return this.embedding.embedSingle(text);
}
```

### A5. 검색/조회에서 superseded 제외

**파일:** `src/memory/memory-service.ts`

1. `search()` — 기본 필터에 superseded 제외:
```typescript
// Default: exclude superseded unless explicitly included
if (!options?.statuses?.length) {
  filters.push(`status != 'superseded'`);
}
```

2. `getByProject()` — 동일 처리:
```typescript
// Default: exclude superseded
if (!options?.statuses?.length) {
  filters.push(`status != 'superseded'`);
}
```

3. `SearchOptions` 확장:
```typescript
export interface SearchOptions {
  // ... existing ...
  includeSuperseded?: boolean;
}
```
`includeSuperseded: true`면 superseded 필터 생략.

---

## Phase B: CLI 및 MCP 확장

### B1. CLI 명령어

**파일:** `src/cli/memory.ts`

1. `memory supersede <oldId> <newId>` — 수동 supersede:
```
memory supersede <oldId> <newId>    Manually mark oldId as superseded by newId
```
- 두 기억 모두 존재 확인
- `markSuperseded()` 호출

2. `memory unsupersede <id>` — supersede 해제:
```
memory unsupersede <id>              Undo supersede, restore to 'open'
```
- status → 'open', supersededById/supersededAt 초기화
- 연결된 신규 기억의 supersedesId 초기화

3. `memory list` 또는 `search`에서 superseded 이력 옵션:
```
--include-superseded    Include superseded memories in results
```

### B2. MCP 서버 확장

**파일:** `src/mcp/memory-server.ts`

1. `sc_memory_search`, `sc_memory_list`에 `includeSuperseded` 파라미터 추가
2. 결과 표시에 supersede 관계 표시:
```
[decision, score:85.2%, supersedes:abc123]
```

---

## Phase C: Topic Alias (미래, 이번에 구현 안 함)

- topicKey 파편화는 retag + topicKey injection으로 이미 부분 해결
- alias map은 복잡도 대비 효과가 적어 보류

---

## 구현 순서

```
A1 (스키마) → A2 (핵심 메서드) → A3 (distill 확장) → A4 (collector 통합) → A5 (검색 필터) → B1 (CLI) → B2 (MCP)
```

## Codex Review

전체 방향은 타당합니다. 다만 Phase A에 바로 반영해야 하는 수정 포인트가 있습니다.

### 1) 스코어링 가중치/임계치(0.65) 적절성

- `0.65`는 현재 공식에서 경계값이 애매합니다.
  - topicKey 불일치 케이스는 사실상 통과가 매우 어렵고(최대치가 0.65 근처),
  - topicKey 일치 케이스는 vector가 낮아도 anchor+kind로 통과할 수 있습니다.
- 권장:
  - 가중치 조정: `topic 0.30`, `vector 0.40`, `anchor 0.20`, `kind 0.10`
  - 임계치 상향: `>= 0.72`
  - 하드 게이트 추가:
    - `vector >= 0.78`
    - `(topicKey exact match) OR (anchor overlap >= 0.5)`

### 2) 규칙 게이트 update signal 패턴 충분성

- 현재 패턴은 시작점으로 괜찮지만 누락이 있습니다.
- 추가 권장 패턴:
  - 한국어: `수정`, `오타`, `아니고`, `아니라`, `대신`, `말고`, `정확히`, `...으로 바뀜`
  - 영어: `actually`, `not ... but ...`, `instead`, `renamed`, `moved to`
- 정규식 보정:
  - `[→→]`는 중복 문자 클래스라 `->|→` 형태로 명시하는 것이 낫습니다.
- 핵심:
  - 문자열 신호만으로 update 확정하지 말고, 후보 memory와 비교해 anchor/값 차이가 실제 존재할 때만 update 확정 권장.

### 3) LanceDB schemaless + 새 필드 호환성

- 이 항목은 **중요**: 현재 테이블은 새 필드를 자동 수용하지 않습니다.
- 로컬 재현 결과:
  - 기존 스키마 테이블에 `add({ supersedesId: ... })` → 실패
  - 기존 컬럼 없는 상태에서 `update({ supersededById: ... })` → 실패
- 즉, A1 구현 전제에 **명시적 마이그레이션**이 필요합니다.
- 권장:
  - `initialize()` 시 `table.schema()` 확인 후 누락 컬럼을 `table.addColumns(...)`로 추가
  - 예: `supersedesId`, `supersededById`, `supersededAt` 기본값 `''`
  - 마이그레이션 실패 시 supersede 기능 비활성 + 경고 로그 (fail-open for core memory path)

### 4) `embedForSearch()` 헬퍼 필요성

- 필요합니다. collector가 embedding provider 내부를 직접 알면 계층이 깨집니다.
- `MemoryService.embedForSearch()`(또는 `embedText()`)로 추상화하는 것이 맞습니다.
- 추가 권장:
  - 같은 turn에서 vector 재사용 경로를 열어 double-embedding 방지
  - 예: `storeWithVector(...)` 또는 `storeIfNew(..., { vector })` 형태로 통합

### 5) Phase C (Topic Alias) 보류 동의 여부

- **동의**합니다. 첫 릴리스에서 과도한 복잡도를 줄이는 판단이 맞습니다.
- 단, 보류 시 관측 지표를 반드시 정의하세요.
  - `update 판정 후 candidate miss 비율`
  - `topicKey mismatch로 create fallback된 비율`
- 위 지표가 임계(예: 15~20% 이상)면 Phase C를 우선순위 상향하는 조건부 계획을 문서에 추가 권장.

### 추가 반영 권장 (작은 수정)

- A5의 `includeSuperseded` 설계는 좋습니다. 다만 기본 검색/목록에서 `status != 'superseded'`를 넣을 때, `statuses`가 명시되면 우선순위를 명확히 정의하세요.
- `markSuperseded(oldId, newId)`는 두 번의 update가 원자적이지 않으므로, 실패 시 보정 로직(역방향 롤백 또는 재시도 큐)을 두면 운영 안정성이 올라갑니다.

## 변경 파일 요약

| 단계 | 파일 | 변경 내용 |
|------|------|----------|
| A1 | `memory-service.ts` | MemoryStatus, MemoryUnit, store(), mapRowToUnit() 확장 |
| A2 | `memory-service.ts` | markSuperseded(), findSupersedeCandidate(), embedForSearch() 추가 |
| A3 | `distill-service.ts` | DistillResult 확장, SYSTEM_PROMPT 업데이트, parseResponse() 확장 |
| A4 | `memory-collector.ts` | distillAndStore()에 supersede 분기 추가 |
| A5 | `memory-service.ts` | search(), getByProject()에 superseded 제외 필터 |
| B1 | `cli/memory.ts` | supersede, unsupersede 명령어 추가 |
| B2 | `mcp/memory-server.ts` | includeSuperseded 파라미터, 결과 표시 확장 |

## 리스크 및 안전장치

1. **오탐 방지:** LLM 판정 + 규칙 게이트 + score 임계치 3중 검증. confidence < 0.8이면 create fallback.
2. **데이터 보존:** 삭제 없이 status='superseded'로 보존. 양방향 링크로 이력 추적 가능.
3. **롤백:** `memory unsupersede <id>`로 언제든 복구.
4. **기존 데이터 영향:** 스키마에 새 필드 추가하지만, LanceDB는 schemaless이므로 기존 레코드에 빈 문자열('')로 처리. 마이그레이션 불필요.
5. **성능:** findSupersedeCandidate()는 vector search(이미 존재하는 로직) 기반이므로 추가 비용 최소.

## 검증 방법

- **A1~A2:** `memory supersede <oldId> <newId>` 수동 실행 → 상태 변경 확인
- **A3:** distill-test에 update 케이스 추가 (예: "회의 시간 2시에서 3시로 변경")
- **A4:** 실제 메시지 흐름에서 update 감지 → supersede 로그 확인
- **A5:** search 결과에서 superseded 기억 제외 확인
- **B1:** CLI supersede/unsupersede 명령어 테스트
