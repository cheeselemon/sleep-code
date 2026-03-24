# Memory Task Lifecycle Problem Analysis

## Problem Statement
Daily Digest keeps showing completed tasks as "to do". Pre-digest consolidation runs but finds 0 items to clean, despite 33 open tasks in sleep-code alone being clearly completed.

## Current System
1. **Distill** (Claude SDK haiku): classifies messages → store with kind (task/decision/fact/observation) + status (open)
2. **Consolidation Phase 4**: auto-resolves open tasks by finding completion evidence via:
   - Strategy 1: Same topicKey match (decision/fact with completion keywords newer than task)
   - Strategy 2: Vector similarity fallback (0.80 threshold)
   - Strategy 3: Date-based expiry for schedule tasks

## Evidence of the Problem

### Example 1: Task text itself contains completion language
```
kind=task, status=open, topicKey=memory-retag
text: "모든 프로젝트 리태깅 완료. sleep-code, personal-memory, cpik-inc, tpt-strategy 총 412건 리태깅."
```
This IS a completion report, not a task. But distill classified it as `kind=task`.

### Example 2: Task was done in this session but evidence has different topicKey
```
kind=task, status=open, topicKey=task-prioritization, p:9
text: "남은 4가지 작업: 1) F+C 노이즈 정리 (112건 삭제), 2) A등급 중복 병합..."
```
All 4 items were completed, but completion evidence was stored under different topicKeys (memory-cleanup, consolidation, etc.), so Phase 4 Strategy 1 (topicKey match) misses it.

### Example 3: Old tasks that are clearly stale
```
kind=task, status=open, topicKey=memory-system, p:5
text: "서버 재시작 없이 테스트 및 수정 진행"
```
This is a one-time instruction, not an ongoing task. Should never have been stored as a task.

## Root Causes to Investigate

1. **Distill misclassification**: Completion reports stored as `task` instead of `decision` or `fact`
2. **TopicKey fragmentation**: Same work stream gets different topicKeys, breaking Phase 4 Strategy 1
3. **Vector similarity threshold**: Strategy 2 (0.80) might be too strict, or embeddings of tasks vs completions are too different
4. **Lack of self-resolution**: Tasks whose own text contains completion keywords aren't auto-resolved
5. **Ephemeral instructions stored as tasks**: "서버 재시작해줘", "테스트 진행" etc. should be skipped entirely

## Current Open Tasks (sleep-code, 33 items)
See the full list in the conversation. Key patterns:
- Documentation updates (README, SDK docs) — many already done
- Implementation tasks (interruptSession, memory commands) — most completed
- Cleanup tasks (Chinese removal, retag) — all completed
- One-time instructions mistakenly stored as tasks

## Questions for Discussion
1. What's the real root cause — distill quality or resolution logic?
2. Should we fix distill to stop creating bad tasks, or fix consolidation to clean them better, or both?
3. Is the 5-bucket digest format even right, or should we rethink what "memory" means for the digest?
4. Should tasks have a TTL by default (e.g., auto-expire after 14 days unless explicitly high-priority)?
5. Is there a smarter way to link tasks to their completion evidence beyond topicKey and vector similarity?
