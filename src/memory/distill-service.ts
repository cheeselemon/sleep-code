import { logger } from '../utils/logger.js';
import { ChatService, type ChatMessage } from './chat-provider.js';
import type { MemoryKind } from './memory-service.js';

const log = logger.child({ component: 'distill' });

// ── Types ────────────────────────────────────────────────────

export interface SlidingMessage {
  speaker: string;
  content: string;
}

export interface DistillInput {
  message: {
    speaker: string;
    content: string;
    timestamp: string;
  };
  context: SlidingMessage[];
  existingTopicKeys?: string[];  // inject known topics for consistency
}

export interface DistillResult {
  shouldStore: boolean;
  distilled: string;
  kind: MemoryKind;
  priority: number;
  topicKey: string;
  speaker?: string;           // LLM-determined decision maker override
  memoryAction?: 'create' | 'update' | 'resolve_task';  // new info, correction, or task completion
  updateConfidence?: number;            // 0.0 ~ 1.0
  anchorTerms?: string[];               // key entities (names, places, dates, times)
  resolveTaskIds?: string[];            // IDs of open tasks this message completes
}

export interface OpenTaskRef {
  id: string;
  text: string;
  topicKey: string;
  priority: number;
}

// ── Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a ruthless long-term memory filter. You REJECT 80%+ of messages. Only knowledge worth remembering 6 MONTHS from now survives.

## Core Principle — Think like the human brain

The brain forgets 90% of a conversation within minutes. What survives:
- The FINAL CONCLUSION, not the deliberation path (Peak-End Rule)
- The EXTRACTED KNOWLEDGE, not who said what when (Semanticization)
- The GIST (bottom-line meaning), not verbatim details (Fuzzy-Trace Theory)
- WHO decided/committed to WHAT (Social Memory)
- SURPRISES and FAILURES — things that broke expectations

## STORE (shouldStore: true) — ONLY these, nothing else

1. **CEO/human decisions**: concrete choice made by a human with authority
   - "벡터DB를 LanceDB로 확정" ✅
   - "환불 위약금은 계약일 기준 30일 이내면 면제" ✅
2. **Project-specific lessons**: knowledge UNIQUE to this project, not in any docs
   - "SDK resume 시 --session-id를 함께 쓰면 크래시 발생" ✅ (project-specific bug)
   - "Prisma include는 N+1 없음" ❌ (general knowledge, in Prisma docs)
3. **Architecture rules**: how THIS project is built (not general tech facts)
   - "distill은 Claude SDK sonnet, 임베딩은 Ollama 유지" ✅
4. **User preferences / constraints**: ongoing rules from the human
   - "as any 캐스팅 사용 금지" ✅
5. **Corrections that change prior knowledge**: explicit override of something stored
   - "중복 임계값 0.85에서 0.90으로 상향" ✅
6. **Surprising failures**: unexpected outcomes worth avoiding next time
   - "Turbopack에서 extensionAlias 미지원으로 충돌" ✅

## SKIP (shouldStore: false) — when in doubt, SKIP

1. **Process narration**: "확인 중", "조사하겠습니다", "진행 중", "커밋 완료"
2. **Meta-descriptions**: "SnoopDuck 요청", "Claude가 계획을 세움" → WHAT was the plan?
3. **Routine confirmations**: "OK", "ㅇㅇ", "알겠습니다", "진행해"
4. **Intermediate deliberation**: "A할까 B할까?" → wait for the FINAL choice
5. **General technical knowledge**: framework/library behavior available in official docs
   - "Prisma include는 batch query로 처리" ❌ (Prisma docs에 있음)
   - "Next.js App Router는 서버 컴포넌트 기본" ❌ (Next.js docs에 있음)
6. **Intermediate progress reports**: "리뷰 통과", "범위 확정", "데이터 경로 확인"
   → store only the FINAL deliverable, not intermediate checkpoints
7. **Setup/config instructions**: installation steps, environment config
   → these belong in docs, not in memory
8. **Completed one-off tasks**: "파일 생성함", "테스트 통과" → ephemeral
9. **Agent status updates**: "확인했습니다", "검증 완료", "reviewing now"
10. **Emotional reactions**: "짜증나", "좋아!" → no extractable knowledge
11. **Code implementation details**: specific code changes, file edits, refactoring steps
    → code is in git, not in memory

## Deduplication — CRITICAL

Check "Already stored memories" before storing:
1. Same topic + same conclusion → SKIP (already known)
2. Same topic + more detail → UPDATE (supersede the old one)
3. Same topic + contradicts old → UPDATE with correction
4. Genuinely NEW topic or insight → STORE

**Default to SKIP if in doubt. Overstoring is worse than missing something.**

## Priority scale (be strict)

- 9-10: CEO decisions, architecture changes, business rules
- 7-8: implementation direction, major bugs, team rules
- 5-6: useful but uncertain if needed in 6 months → reconsider SKIP
- 1-4: almost certainly should be SKIP instead
If priority < 5, reconsider: should this be SKIP?

## Final gate — before outputting shouldStore:true

"6개월 후 새 세션에서 이 프로젝트를 처음 보는 개발자가 이 정보를 필요로 할까?"
- YES → store
- MAYBE → SKIP (maybe = no)
- NO → SKIP

## distilled text rules

- Extract the KNOWLEDGE, not describe the conversation event
- BAD: "SnoopDuck 요청하여 조사 수행" → SKIP (meta-description)
- BAD: "Claude가 구현 계획을 작성함" → SKIP (meta-description)
- BAD: "CPI-270 리뷰 통과" → SKIP (intermediate progress)
- GOOD: "환불 위약금은 계약일 기준 30일 이내면 면제"
- GOOD: "SDK resume 시 resume만 단독 사용해야 함 (sessionId 병용 시 크래시)"
- Max 200 chars, 1-2 sentences
- Write in the SAME LANGUAGE as the original message
- NEVER output Chinese or Japanese text

## Fields

- kind: fact | task | observation | proposal | feedback | dialog_summary | decision
- priority: 0-10 (strict scale above)
- topicKey: short English tag. Reuse existing keys when possible.
- speaker: who MADE the decision (user/claude/codex/system)
- memoryAction: "create" | "update" | "resolve_task"
  - update: corrects/changes existing memory (supersede). Signals: "→", "변경", "정정", "취소", "수정", "대신"
  - resolve_task: completes open task. Set resolveTaskIds.
  - Default: "create"
- updateConfidence: 0.0-1.0
- anchorTerms: key entities (names, file paths, numbers, dates)
- resolveTaskIds: task IDs completed (only when memoryAction is "resolve_task")

## Response format

JSON only (no markdown):
{"shouldStore": boolean, "distilled": "string", "kind": "string", "priority": number, "topicKey": "string", "speaker": "string", "memoryAction": "create"|"update"|"resolve_task", "updateConfidence": number, "anchorTerms": ["string"], "resolveTaskIds": ["string"]}

IMPORTANT: Always include ALL 10 fields.`;

// ── 2nd Pass Review Prompt ──────────────────────────────────

const REVIEW_PROMPT = `You are a strict quality reviewer for a memory distillation system.
You receive the original messages and their proposed classifications from Pass 1.
Your job: REJECT anything that shouldn't be stored. You are the final gate.

## Review each STORE item against these criteria:

1. **6-Month Test**: Would a new developer need this info 6 months from now? If not → flip to SKIP
2. **Deduplication**: Is this essentially the same as an existing memory? → flip to SKIP
3. **General knowledge**: Is this in official docs for the framework/library? → flip to SKIP
4. **Progress report**: Is this an intermediate step, not a final conclusion? → flip to SKIP
5. **Kind check**: Is a completion report classified as "task"? → flip kind to "fact" or SKIP
6. **Priority inflation**: Is priority >= 7 justified? If not → lower it or SKIP

## Response format

Return a JSON array. For each item:
- If the classification is correct: return as-is
- If it should be SKIP: set shouldStore to false
- If kind/priority needs correction: fix it

JSON array only, same format as input.`;

// ── CJK Detection ───────────────────────────────────────────

const CJK_PATTERN = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/;
const KOREAN_PATTERN = /[\uac00-\ud7af]/;

function hasCJKWithoutKorean(text: string): boolean {
  return CJK_PATTERN.test(text) && !KOREAN_PATTERN.test(text);
}

const CJK_RETRY_PROMPT = `Your previous response contained Chinese/Japanese text. This is NOT allowed.
Rewrite your response in Korean or English ONLY. Respond with JSON only.`;

// ── Service ──────────────────────────────────────────────────

const MAX_RETRIES = 1;

const DEFAULT_SKIP: DistillResult = {
  shouldStore: false,
  distilled: '',
  kind: 'observation',
  priority: 0,
  topicKey: '',
};

const VALID_KINDS = new Set<string>([
  'fact', 'task', 'observation', 'proposal', 'feedback', 'dialog_summary', 'decision',
]);

interface ParseResult {
  result: DistillResult | null;
  cjkRejected: boolean;
}

// ── Batch Types ─────────────────────────────────────────────

export interface ExistingMemoryRef {
  id: string;
  text: string;
  kind: string;
  topicKey: string;
  priority: number;
  createdAt: string;
}

export interface BatchDistillItem {
  id: number;
  project?: string;
  message: { speaker: string; content: string; timestamp: string };
  context: SlidingMessage[];
  existingTopicKeys?: string[];
  openTasks?: OpenTaskRef[];
  existingMemories?: ExistingMemoryRef[];
}

export interface BatchDistillResult {
  id: number;
  result: DistillResult;
}

export class DistillService {
  private chat: ChatService;

  constructor(chat: ChatService) {
    this.chat = chat;
  }

  /**
   * Distill a batch of messages in a single LLM turn.
   * Each item gets an id for correlation with the response array.
   */
  async distillBatch(items: BatchDistillItem[]): Promise<BatchDistillResult[]> {
    if (items.length === 0) return [];
    if (items.length === 1) {
      const single = await this.distill({
        message: items[0].message,
        context: items[0].context,
        existingTopicKeys: items[0].existingTopicKeys,
      });
      return [{ id: items[0].id, result: single }];
    }

    const batchPrompt = this.buildBatchPrompt(items);
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: batchPrompt },
    ];

    try {
      const raw = await this.chat.chat(messages);
      const results = this.parseBatchResponse(raw, items);
      if (results) {
        const resolved = results.filter(r => r.result.resolveTaskIds?.length);
        log.info({
          count: items.length,
          stored: results.filter(r => r.result.shouldStore).length,
          resolved: resolved.length,
        }, 'Batch distill complete');
        return results;
      }
      log.warn({ rawLen: raw.length }, 'Failed to parse batch response, falling back to individual');
    } catch (err) {
      log.warn({ err }, 'Batch distill call failed, falling back to individual');
    }

    // Fallback: distill individually
    return this.distillIndividually(items);
  }

  /**
   * 2nd pass: review distill results and reject/fix misclassifications.
   * Only reviews items that were marked shouldStore=true.
   */
  async reviewBatch(
    items: BatchDistillItem[],
    results: BatchDistillResult[],
    existingMemories: ExistingMemoryRef[],
  ): Promise<BatchDistillResult[]> {
    const toReview = results.filter(r => r.result.shouldStore);
    if (toReview.length === 0) return results;

    // Build review prompt with original messages + pass 1 results + existing memories
    const reviewItems = toReview.map(r => {
      const original = items.find(i => i.id === r.id);
      return {
        id: r.id,
        originalMessage: original?.message.content?.slice(0, 200) ?? '',
        pass1: {
          shouldStore: r.result.shouldStore,
          distilled: r.result.distilled,
          kind: r.result.kind,
          priority: r.result.priority,
          topicKey: r.result.topicKey,
          memoryAction: r.result.memoryAction,
        },
      };
    });

    let prompt = `Review these Pass 1 classifications. Reject or fix as needed.\n\n`;
    prompt += `Pass 1 results to review:\n${JSON.stringify(reviewItems, null, 2)}\n`;

    if (existingMemories.length > 0) {
      const memList = existingMemories.slice(0, 30).map(
        (m) => `  - [${m.kind}/${m.topicKey}] (p:${m.priority}) ${m.text.slice(0, 80)}`,
      );
      prompt += `\nAlready stored memories:\n${memList.join('\n')}\n`;
    }

    prompt += `\nReturn JSON array with corrected items (same format, include id).`;

    const messages: ChatMessage[] = [
      { role: 'system', content: REVIEW_PROMPT },
      { role: 'user', content: prompt },
    ];

    try {
      const raw = await this.chat.chat(messages);
      let jsonStr = raw.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) throw new Error('Not an array');

      let flipped = 0;
      const resultMap = new Map(results.map(r => [r.id, r]));

      for (const reviewed of parsed) {
        const existing = resultMap.get(reviewed.id);
        if (!existing) continue;

        if (reviewed.shouldStore === false && existing.result.shouldStore === true) {
          existing.result.shouldStore = false;
          flipped++;
        } else if (reviewed.shouldStore === true) {
          // Apply corrections (kind, priority)
          if (reviewed.kind) existing.result.kind = reviewed.kind;
          if (reviewed.priority !== undefined) existing.result.priority = reviewed.priority;
          if (reviewed.distilled) existing.result.distilled = reviewed.distilled;
        }
      }

      const finalStored = results.filter(r => r.result.shouldStore).length;
      log.info({ reviewed: toReview.length, flipped, finalStored }, '2nd pass review complete');
      return results;
    } catch (err) {
      log.warn({ err }, '2nd pass review failed, using pass 1 results');
      return results;
    }
  }

  private buildBatchPrompt(items: BatchDistillItem[]): string {
    // Collect all unique topicKeys across items
    const allTopicKeys = new Set<string>();
    for (const item of items) {
      if (item.existingTopicKeys) {
        for (const k of item.existingTopicKeys) allTopicKeys.add(k);
      }
    }

    // Collect open tasks from all items (deduplicated)
    const openTaskMap = new Map<string, OpenTaskRef>();
    for (const item of items) {
      if (item.openTasks) {
        for (const t of item.openTasks) openTaskMap.set(t.id, t);
      }
    }

    const batch = items.map((item) => {
      const contextLines = item.context.map((m) => `${m.speaker}: ${m.content}`);
      return {
        id: item.id,
        project: item.project ?? 'default',
        speaker: item.message.speaker,
        content: item.message.content,
        timestamp: item.message.timestamp,
        context: contextLines,
      };
    });

    let prompt = `Evaluate each message below independently. Return a JSON array with one object per message.\n\n`;
    prompt += `Messages:\n${JSON.stringify(batch, null, 2)}\n`;

    if (allTopicKeys.size > 0) {
      prompt += `\nExisting topicKeys: ${Array.from(allTopicKeys).join(', ')}`;
      prompt += `\nReuse existing topicKeys when the topic matches.\n`;
    }

    // Inject open tasks (batch is single-project, so deduplicate only)
    if (openTaskMap.size > 0) {
      const taskList = Array.from(openTaskMap.values()).map(
        (t) => `  - id:"${t.id}" [${t.topicKey}] (p:${t.priority}) ${t.text.slice(0, 100)}`,
      );
      prompt += `\nCurrently open tasks:\n${taskList.join('\n')}`;
      prompt += `\nIf a message indicates any of these tasks are COMPLETED, set memoryAction:"resolve_task" and resolveTaskIds:[matching task ids]. Store the completion as kind:"fact".\n`;
    }

    // Inject existing memories (batch is single-project, so deduplicate only)
    const existingMemories = new Map<string, ExistingMemoryRef>();
    for (const item of items) {
      if (item.existingMemories) {
        for (const m of item.existingMemories) existingMemories.set(m.id, m);
      }
    }
    if (existingMemories.size > 0) {
      const memList = Array.from(existingMemories.values()).map(
        (m) => `  - [${m.kind}/${m.topicKey}] (p:${m.priority}) ${m.text.slice(0, 80)}`,
      );
      prompt += `\nAlready stored memories (last 7 days):\n${memList.join('\n')}`;
      prompt += `\nIMPORTANT: If a message repeats or is very similar to an existing memory, SKIP it (shouldStore: false).`;
      prompt += `\nIf a message updates/corrects an existing memory, set memoryAction:"update". The system will find the matching memory to supersede automatically.\n`;
    }

    prompt += `\nRespond with a JSON array: [{"id": 0, "shouldStore": ..., "distilled": ..., "kind": ..., "priority": ..., "topicKey": ..., "speaker": ..., "memoryAction": ..., "updateConfidence": ..., "anchorTerms": [...], "resolveTaskIds": [...]}, ...]`;
    prompt += `\nIMPORTANT: Return ONLY the JSON array. One object per message, in the same order.`;

    return prompt;
  }

  private parseBatchResponse(raw: string, items: BatchDistillItem[]): BatchDistillResult[] | null {
    try {
      // Try to extract JSON array from the response
      let jsonStr = raw.trim();

      // Handle markdown code blocks
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return null;

      const results: BatchDistillResult[] = [];
      for (const item of items) {
        const match = parsed.find((p: any) => p.id === item.id) ?? parsed[items.indexOf(item)];
        if (!match) {
          results.push({ id: item.id, result: { ...DEFAULT_SKIP } });
          continue;
        }

        const { result } = this.parseResponse(JSON.stringify(match));
        results.push({ id: item.id, result: result ?? { ...DEFAULT_SKIP } });
      }

      return results;
    } catch {
      return null;
    }
  }

  private async distillIndividually(items: BatchDistillItem[]): Promise<BatchDistillResult[]> {
    log.warn({ count: items.length }, 'Falling back to individual distill (openTasks/existingMemories preserved with reduced context)');
    const results: BatchDistillResult[] = [];
    for (const item of items) {
      // Build individual prompt with reduced context from openTasks/existingMemories
      let extraContext = '';
      if (item.openTasks && item.openTasks.length > 0) {
        const taskLines = item.openTasks.slice(0, 10).map(
          (t) => `  - id:"${t.id}" [${t.topicKey}] ${t.text.slice(0, 60)}`,
        );
        extraContext += `\nOpen tasks:\n${taskLines.join('\n')}\n`;
      }
      if (item.existingMemories && item.existingMemories.length > 0) {
        const memLines = item.existingMemories.slice(0, 15).map(
          (m) => `  - [${m.kind}/${m.topicKey}] ${m.text.slice(0, 60)}`,
        );
        extraContext += `\nExisting memories:\n${memLines.join('\n')}\nSKIP if similar to existing.\n`;
      }
      const result = await this.distill({
        message: item.message,
        context: item.context,
        existingTopicKeys: item.existingTopicKeys,
      }, extraContext);
      results.push({ id: item.id, result });
    }
    return results;
  }

  async distill(input: DistillInput, extraContext?: string): Promise<DistillResult> {
    const userPrompt = this.buildUserPrompt(input) + (extraContext ?? '');
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const raw = await this.chat.chat(messages);
        const { result, cjkRejected } = this.parseResponse(raw);

        // CJK detected → append correction and retry
        if (cjkRejected && attempt < MAX_RETRIES) {
          log.warn({ attempt, text: raw.slice(0, 80) }, 'CJK detected, retrying with correction');
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: CJK_RETRY_PROMPT });
          continue;
        }

        if (cjkRejected) {
          log.warn('CJK retry also failed, skipping');
          return DEFAULT_SKIP;
        }

        if (result) {
          log.debug(
            { shouldStore: result.shouldStore, kind: result.kind, topic: result.topicKey },
            'Distill complete'
          );
          return result;
        }

        log.warn({ attempt, raw: raw.slice(0, 200) }, 'Failed to parse distill response');
      } catch (err) {
        log.warn({ attempt, err }, 'Distill call failed');
      }
    }

    log.warn('Distill failed after retries, skipping');
    return DEFAULT_SKIP;
  }

  private buildUserPrompt(input: DistillInput): string {
    const contextLines = input.context.map(
      (m) => `${m.speaker}: ${m.content}`
    );

    let prompt = '';
    if (contextLines.length > 0) {
      prompt += `Recent conversation context:\n${contextLines.join('\n')}\n\n`;
    }
    prompt += `Current message:\n${input.message.speaker}: ${input.message.content}\n`;
    prompt += `\nTimestamp: ${input.message.timestamp}`;

    if (input.existingTopicKeys && input.existingTopicKeys.length > 0) {
      prompt += `\n\nExisting topicKeys for this project: ${input.existingTopicKeys.join(', ')}`;
      prompt += `\nReuse an existing topicKey if the topic matches. Only create a new one if truly novel.`;
    }

    prompt += `\n\nShould this message be remembered? Respond with JSON only.`;

    return prompt;
  }

  private isVagueText(text: string): boolean {
    const hasKorean = /[\uac00-\ud7af]/.test(text);
    const minLen = hasKorean ? 15 : 30;
    if (text.length < minLen) return true;

    // ── Concrete signals — if any present, not vague ──
    const concreteSignals = [
      /\d{1,2}[\/\-\.]\d{1,2}/,           // dates (3/6, 03-07)
      /\d+[만천백억원%개건명시분]/,           // Korean numbers with units
      /\d{2,}/,                             // numbers 2+ digits
      /[a-zA-Z0-9_./-]+\.[a-zA-Z]{2,4}/,   // file paths, emails, URLs
      /`[^`]+`/,                            // code tokens
      /0\.\d+/,                             // decimal values (thresholds)
      /→|->|에서\s.*로/,                     // update/change arrows
    ];
    if (concreteSignals.some((p) => p.test(text))) return false;

    // ── Noise patterns — always vague ──
    const noisePatterns = [
      // "Subject 요청/지시/결정" without substance
      /^(User|사용자|SnoopDuck|CEO).{0,20}(requested|요청|확인|논의|asked|mentioned|지시|동의)/i,
      /^(Claude|Codex).{0,20}(confirmed|completed|agreed|확인|완료|동의|작성|수행|진행)/i,

      // Process narration endings
      /(확인함|진행 중|작업 중|처리함|implemented|completed|시작|커밋 완료|업데이트 확인)\.?$/i,

      // "did X task" without saying what
      /^.{0,30}(조사|리뷰|검토|수행|작업|처리|확인).{0,10}$/i,

      // Ephemeral task completion (should be in git log, not memory)
      /커밋.{0,10}(완료|성공)|push.{0,5}(완료|done)|빌드.{0,5}(완료|성공)/i,
      /npm\s+(install|build|run)\s+완료/i,

      // Agent noise even if longer than minLen
      /^(Claude|Codex)\s+(설명|확인|제안).{0,5}:/i,

      // "SnoopDuck 결정 + vague action" without what was decided
      /결정.{0,5}(미리|먼저|나중에|다음에|일단)\s/i,
    ];
    return noisePatterns.some((p) => p.test(text));
  }

  private parseResponse(raw: string): ParseResult {
    try {
      let jsonStr = raw.trim();
      // Strip markdown code blocks (```json ... ``` or ``` ... ```)
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }
      const parsed = JSON.parse(jsonStr);

      // Accept common LLM field-name variants for the boolean
      const shouldStore =
        parsed.shouldStore ??
        parsed.should_store ??
        parsed.remember ??
        parsed.should_remember ??
        parsed.shouldRemember;

      if (typeof shouldStore !== 'boolean') return { result: null, cjkRejected: false };
      if (!shouldStore) return { result: { ...DEFAULT_SKIP, shouldStore: false }, cjkRejected: false };

      if (typeof parsed.distilled !== 'string' || parsed.distilled.length === 0) return { result: null, cjkRejected: false };

      // Substance validation: reject vague meta-descriptions
      if (this.isVagueText(parsed.distilled)) {
        log.warn({ text: parsed.distilled }, 'Distilled text too vague, rejecting');
        return { result: { ...DEFAULT_SKIP, shouldStore: false }, cjkRejected: false };
      }

      // Detect CJK language errors (Chinese/Japanese without Korean) → signal retry
      if (hasCJKWithoutKorean(parsed.distilled)) {
        return { result: null, cjkRejected: true };
      }

      if (!VALID_KINDS.has(parsed.kind)) return { result: null, cjkRejected: false };

      const priority = Number(parsed.priority);
      if (isNaN(priority) || priority < 0 || priority > 10) return { result: null, cjkRejected: false };

      // Validate speaker if provided (whitelist)
      const validSpeakers = new Set(['user', 'claude', 'codex', 'system']);
      const speaker = typeof parsed.speaker === 'string' && validSpeakers.has(parsed.speaker)
        ? parsed.speaker
        : undefined;

      // Parse supersede fields
      const updateConfidence = typeof parsed.updateConfidence === 'number'
        ? Math.max(0, Math.min(1, parsed.updateConfidence)) : 0;
      const anchorTerms = Array.isArray(parsed.anchorTerms)
        ? parsed.anchorTerms.filter((t: unknown) => typeof t === 'string' && (t as string).length > 0)
        : [];

      const rawAction: string = parsed.memoryAction ?? 'create';

      // Rule gate: validate "update" action with signal patterns
      let memoryAction: 'create' | 'update' | 'resolve_task' = 'create';
      if (rawAction === 'resolve_task') {
        memoryAction = 'resolve_task';
      } else if (rawAction === 'update' && updateConfidence >= 0.8) {
        const updateSignals = /->|→|에서\s.*로|변경|정정|바뀜|확정|취소|수정|오타|아니고|아니라|대신|말고|actually|instead|renamed|moved to|not\s.*but/i;
        if (updateSignals.test(parsed.distilled) || updateConfidence >= 0.95) {
          memoryAction = 'update';
        }
      }

      // Parse resolveTaskIds
      const resolveTaskIds = Array.isArray(parsed.resolveTaskIds)
        ? parsed.resolveTaskIds.filter((id: unknown) => typeof id === 'string' && (id as string).length > 0)
        : [];

      return {
        result: {
          shouldStore: true,
          distilled: parsed.distilled.slice(0, 200),
          kind: parsed.kind as MemoryKind,
          priority: Math.round(priority),
          topicKey: typeof parsed.topicKey === 'string' ? parsed.topicKey : '',
          speaker,
          memoryAction,
          updateConfidence,
          anchorTerms,
          resolveTaskIds: resolveTaskIds.length > 0 ? resolveTaskIds : undefined,
        },
        cjkRejected: false,
      };
    } catch {
      return { result: null, cjkRejected: false };
    }
  }
}
