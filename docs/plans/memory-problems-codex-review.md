# Memory Problems Verification — Codex Review

## Scope
- Reviewed `docs/plans/memory-problems-verification.md`
- Cross-checked with:
  - Current LanceDB data (`~/.sleep-code/memory/lancedb`, table `memory_units`)
  - Memory pipeline code (`src/memory/*`, `src/mcp/memory-server.ts`)
  - Sleep-code Claude transcript snippets under `~/.claude/projects/...sleep-code/...jsonl`

## What I can confirm from actual data

1. Exact duplicate exists:
- Same `id`, same `text`, same `createdAt` appears twice.
- Example id: `4fccba1d-268b-4954-9e44-dfdac14556c7` (`sleep-code`).

2. Near-duplicate accumulation exists:
- `personal-memory` has 10 records containing `르지트`.
- Many are semantically overlapping, including repetitive “download -> send accountant” variants.

3. Vague distilled text exists:
- Present in DB as-is, including:
  - `User requested thorough investigation. Confirmation needed.`
  - `CLI 서브커맨드 추가하기로 결정`
  - `consolidation, delete, distill prompt improvement, deduplication threshold change implemented`

4. Low search score pattern is evidenced in transcript tool results:
- `duplicate threshold decision` query top score shown as `63.8%`.
- `중복 임계값 결정` query top score shown as `70.9%`.
- I could not rerun live search locally in this sandbox because Ollama/MCP ports are not bindable here, but the recorded MCP outputs are internally consistent.

5. Speaker misattribution exists:
- Memory `중복 임계값을 0.85에서 0.90으로 조정...` is stored with `speaker:claude`.
- In transcript, user says `SnoopDuck: 아하 올려보자` at `2026-03-05T01:28:26.546Z`, then assistant executes and reports update, indicating user-driven decision became claude-attributed memory.

## Answers to the 5 questions

1. Have I observed the same patterns?
- Yes. I independently confirmed 1, 2, 3, and 5 directly from current DB + code + transcript.
- For 4, I confirmed the reported score outputs from transcript logs (not re-executed live due sandbox port restriction).

2. Problem 2 threshold question (0.90 -> lower?):
- Lowering globally is risky and likely regresses earlier false-merge behavior.
- Transcript evidence already shows harmful merge around score `0.86` (`Duplicate detected, reinforced ... score: 0.861...`), which is exactly why threshold was raised.
- Recommendation: keep store-time threshold high (`0.90`) and add second-stage merge logic (topic/time/action-aware) instead of lowering global cosine cutoff.

3. Problem 3 vague text validation:
- Yes, add a post-distill validator.
- Minimum gates should include:
  - reject generic/meta-only phrases (`requested`, `confirmed`, `implemented`) without concrete object/action
  - require at least one concrete entity slot (feature/file/topic/date/value/person)
  - if rejected, either retry distill with stricter prompt or skip storage

4. Problem 4 root cause (embedding vs query):
- Primary cause looks mixed: query-language mismatch + low-specificity stored text + pure vector retrieval without lexical/hybrid guardrails.
- Not primarily a vector dimension issue (`qwen3-embedding:4b`, 2560-dim is already high-capacity).
- In short: retrieval quality is being capped more by memory text quality and retrieval strategy than raw embedding dimension.

5. Additional problems noticed:
- Exact duplicate has same UUID duplicated in table. Semantic dedup cannot prevent duplicate inserts of identical record IDs; this points to an idempotency/ingest-path issue.
- Speaker attribution is structurally tied to current message speaker (`memory-collector` passes `speaker: msg.speaker`), so cross-turn decisions are systematically misattributed.
- Topic drift (`memory-management` vs `duplicate-threshold`) fragments similar decisions and weakens both dedup and retrieval coherence.

## Bottom line
- Your 5-item diagnosis is directionally correct.
- I would rate it as:
  - 1 exact duplicate: confirmed
  - 2 near-duplicate accumulation: confirmed
  - 3 vague distill output: confirmed
  - 4 low retrieval scores: confirmed from recorded tool outputs
  - 5 speaker misattribution: confirmed (not just partial for speaker field; cross-contamination remains unproven)
