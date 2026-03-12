# Memory System Problems — Verification Request

## Purpose
Verify whether the 5 reported memory system problems are REAL (observable in actual data) before attempting any fixes.

## Method
Queried actual LanceDB data via MCP tools (`sc_memory_list`, `sc_memory_search`).

---

## Problem 1: Exact Duplicates

**Status: CONFIRMED**

Evidence from `sc_memory_list project=sleep-code`:
```
[decision, priority:5, speaker:claude, topic:mcp-server]
  MCP 서버가 4b 모델을 사용하는지 확인하기로 결정.
  (2026-03-04T07:11:59.745Z)

[decision, priority:5, speaker:claude, topic:mcp-server]
  MCP 서버가 4b 모델을 사용하는지 확인하기로 결정.
  (2026-03-04T07:11:59.745Z)
```
Identical text, identical timestamp — this is a true duplicate that slipped past dedup (cosine 0.90 threshold).

## Problem 2: Near-Duplicates Not Merged (Same Event, Multiple Entries)

**Status: CONFIRMED**

Same decision stored twice with slightly different wording:
```
[decision, priority:8, topic:memory-management]
  중복 임계값 0.85를 0.90으로 올려 중복 오류 수정하기로 결정
  (2026-03-04T07:53:00.998Z)

[decision, priority:6, topic:duplicate-threshold]
  중복 임계값을 0.85에서 0.90으로 조정하여 비슷한 스케줄은 별도 기억으로 저장하기로 결정
  (2026-03-05T01:29:02.909Z)
```

Also in personal-memory, "르지트 통장 거래내역" appears in **6+ separate memories**:
- "SnoopDuck 지정 밤에 르지트 통장 거래내역 다운로드 실행"
- "3/5 르지트 통장 거래내역 다운로드 → 세무사 전달: 밤에 할 것"
- "르지트 통장 거래내역 다운로드를 밤에 수행하기로 결정"
- "르지트 통장 거래내역 전달 건 세무사 kdhy4879@naver.com으로 전달하기로 확정"
- "세무사에게 르지트 통장 거래내역을 kdhy4879@naver.com으로 전달하기로 확정"
- "르지트 통장 거래내역 전달 건 세무사 kdhy4879@naver.com로 기억해두기로 결정"

These should consolidate into 1-2 memories max.

## Problem 3: Vague / Substance-less Distilled Text

**Status: CONFIRMED**

Examples:
```
"User requested thorough investigation. Confirmation needed."
  → What investigation? About what?

"CLI 서브커맨드 추가하기로 결정"
  → Which subcommand? For what purpose?

"consolidation, delete, distill prompt improvement, deduplication threshold change implemented"
  → Laundry list with no specifics

"SnoopDuck 요청하여 쓸모없는 코드 비율 찾는 작업 수행"
  → What code? What was the result?
```

The distill prompt says "BAD: meta-descriptions without substance" but the LLM still produces them.

## Problem 4: Low Search Accuracy / Scores

**Status: CONFIRMED**

Searching "duplicate threshold decision" returns top score of only **63.8%**.
Searching "중복 임계값 결정" (Korean, exact topic) returns top score of **70.9%**.

Even exact-topic queries rarely exceed 75%. This makes recall unreliable — important memories can be missed when the query phrasing differs slightly from the stored text.

## Problem 5: Speaker Attribution / Cross-Contamination

**Status: PARTIALLY CONFIRMED**

Many entries have `speaker:claude` for decisions that were actually user-driven or joint decisions:
```
[decision, speaker:claude] 중복 임계값 0.85를 0.90으로 올려 중복 오류 수정하기로 결정
```
This was a USER decision, not Claude's autonomous choice. The distill model assigns speaker based on who said the message, but decisions often span multiple messages.

Cross-contamination between events is harder to verify without raw message logs. The sliding window approach means context from event A could bleed into distill judgment for event B.

---

## Summary of Verified Problems

| # | Problem | Real? | Severity |
|---|---------|-------|----------|
| 1 | Exact duplicates | YES | High — pollutes search results |
| 2 | Near-duplicates not merged | YES | High — same info stored 6+ times |
| 3 | Vague distilled text | YES | High — memories lack actionable substance |
| 4 | Low search scores | YES | Medium — queries below 75% miss important items |
| 5 | Speaker misattribution | PARTIAL — confirmed for speaker field; cross-contamination needs raw log analysis |

## Questions for Codex

1. Have you observed these same patterns in your interactions with the memory system?
2. For Problem 2 (near-duplicates): the current cosine threshold is 0.90 at store-time. Do you think lowering it would help, or would it cause false merges?
3. For Problem 3 (vague text): should we add a post-distill validation step that rejects entries without specific nouns/details?
4. For Problem 4 (low scores): is this an embedding model issue (qwen3-embedding dimension/quality) or a query formulation issue?
5. Any other problems you've noticed that aren't listed here?
