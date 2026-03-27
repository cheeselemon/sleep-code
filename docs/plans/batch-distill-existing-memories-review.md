# Batch Distill Existing Memories Review

## Findings

### 1. High: cross-project contamination in the batch prompt can resolve or skip against the wrong project's memory/task

Files:

- `src/memory/batch-distill-runner.ts:313-363`
- `src/memory/distill-service.ts:252-302`

Why it matters:

- `processBatch()` correctly fetches `openTasks` / `existingMemories` per project.
- But `buildBatchPrompt()` flattens all `item.openTasks` into one global `openTaskMap`, and all `item.existingMemories` into one global `existingMemories` map.
- Those prompt lines do not include project labels.

Impact:

- A message from project A can be judged against project B's stored memories.
- The model can mark `resolveTaskIds` for a task from the wrong project.
- `processDistillResult()` then blindly calls `updateStatus(taskId, 'resolved')` without checking project ownership.

This is the most serious issue in the change. It is both a correctness bug and a token bloat multiplier.

Recommended fix:

- Either batch per project, or include `project` on each message/task/memory and instruct the model to only compare within the same project.
- Also validate resolved task IDs belong to the current message's project before updating them.

### 2. High: the "recent 30 non-task memories" query is not actually recent, and it drops non-open memories

Files:

- `src/memory/batch-distill-runner.ts:319-338`
- `src/memory/memory-service.ts:360-380`

Why it matters:

- The code comment says "recent 30", but the query is `getByProject(project, { statuses: ['open'], limit: 100 })`.
- `getByProject()` does no sort by `createdAt`; it just queries and limits.
- Then the caller sorts only by `priority`, not by time.

So the prompt is not getting "recent 30". It is getting "some 100 open records, then top 30 non-task by priority".

Impact:

- Old high-priority memories can crowd out actual recent context.
- Once tasks/facts start using `resolved` or `expired`, those memories disappear from the candidate set entirely.
- The LLM may miss the exact prior memory it needs for update/supersede decisions.

Recommended fix:

- Fetch non-superseded memories without `statuses: ['open']`, then sort by `createdAt` desc and cap by a small recent window before any priority tie-break.
- If only one knob is allowed now, change the comment because the current behavior is not "recent 30".

### 3. Medium: token overflow risk is amplified by global aggregation, and fallback loses the new behavior entirely

Files:

- `src/memory/distill-service.ts:271-305`
- `src/memory/distill-service.ts:342-351`
- `src/memory/memory-config.ts:70`

Why it matters:

- Default `batchMaxMessages` is 20.
- The prompt now contains:
  - up to 20 messages with context
  - all deduped open tasks across the whole batch
  - all deduped existing memories across the whole batch
  - the system prompt plus JSON schema

If this overflows or causes parse failure, `distillBatch()` falls back to `distillIndividually()`.

Problem:

- `distillIndividually()` only passes `message`, `context`, and `existingTopicKeys`.
- It drops `openTasks` and `existingMemories` entirely.

So under the exact high-token scenario this feature is trying to handle, duplicate suppression / update hints / task resolution all silently disappear.

Recommended fix:

- Add size caps before prompt assembly.
- Preserve the new context in individual fallback, or log explicitly that these features are disabled in fallback mode.

### 4. Medium: the new prompt asks the model to reference which memory is superseded, but the code does not parse or use any explicit memory reference

Files:

- `src/memory/distill-service.ts:299-304`
- `src/memory/distill-service.ts:507-545`
- `src/memory/batch-distill-runner.ts:480-514`

Why it matters:

- The prompt says: if updating/correcting an existing memory, "reference which memory is being superseded in your distilled text."
- But `parseResponse()` has no field for a target memory ID.
- The runtime supersede path still relies on `anchorTerms + topicKey + vector` search.

Impact:

- The "Already stored memories" section can help the model semantically, but the specific memory IDs shown in the prompt are not machine-consumed.
- Worse, the model may start echoing IDs or reference-like text into `distilled`, which would pollute stored memory text.

Recommended fix:

- Either remove that instruction from the prompt, or add a machine-readable field like `supersedeMemoryId` and validate it.
- If not adding a field now, keep the prompt instruction at the semantic level only.

### 5. Low: resolved task count is logged but not included in the emitted batch result

File:

- `src/memory/batch-distill-runner.ts:371-414`

Why it matters:

- `resolved` is counted locally and logged.
- But `BatchResult` has no `resolved` field, so downstream consumers cannot display it.

This is not a blocker, but it makes the new path harder to observe and debug.

## Answers To The Requested Review Points

### Prompt token overflow risk

Yes, the risk is real.

The bigger issue is not only raw size, but that the prompt currently aggregates cross-project open tasks and memories into a single global list. That increases both token count and semantic confusion.

### Existing memory query quality

Not ideal in the current form.

- `statuses: ['open']` is too narrow for "existing memories"
- `limit: 100` plus no sort is not "recent"
- sorting by priority after fetch biases toward old important memories rather than recent likely-match memories

### Supersede execution path

Yes, there is still a real supersede execution path:

- `parseResponse()` accepts `memoryAction: "update"`
- `processDistillResult()` calls `findSupersedeCandidate()`
- on match, it stores the new memory and marks the old one superseded

But the newly added prompt context does not yet provide a machine-readable path to choose a specific existing memory ID. It is still only a hint to the LLM.

### Missed edge cases

- Multi-project contamination is the biggest missed edge case.
- Fallback mode dropping the new context is the second biggest.
- "Recent 30" comment does not match actual behavior.

## Suggested minimal next step

If you want the smallest safe correction before broader refactoring:

1. Restrict each batch prompt to one project, or label every injected task/memory with project and validate project on resolve.
2. Cap injected existing memories aggressively.
3. Make fallback preserve `openTasks` / `existingMemories`, or at least log the downgrade loudly.
