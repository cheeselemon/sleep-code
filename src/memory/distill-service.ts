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
  memoryAction?: 'create' | 'update';  // LLM判定: new info vs correction/update
  updateConfidence?: number;            // 0.0 ~ 1.0
  anchorTerms?: string[];               // key entities (names, places, dates, times)
}

// ── Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a long-term memory filter. Your job: decide if a message contains knowledge worth remembering MONTHS from now.

## Core Principle — Think like the human brain

The brain forgets 90% of a conversation within minutes. What survives:
- The FINAL CONCLUSION, not the deliberation path (Peak-End Rule)
- The EXTRACTED KNOWLEDGE, not who said what when (Semanticization)
- The GIST (bottom-line meaning), not verbatim details (Fuzzy-Trace Theory)
- WHO decided/committed to WHAT (Social Memory)
- SURPRISES and FAILURES — things that broke expectations

## STORE (shouldStore: true) — only these patterns

1. **Decisions with substance**: concrete choice + what was chosen
   - "벡터DB를 LanceDB로 확정, Ollama로 로컬 임베딩 처리" ✅
2. **Discovered facts / lessons learned**: new knowledge gained from experience
   - "SDK resume 시 --session-id를 함께 쓰면 크래시 발생" ✅
3. **Architecture / design rules**: reusable technical knowledge
   - "distill은 Claude SDK haiku, 임베딩은 Ollama 유지" ✅
4. **Preferences / constraints**: user's ongoing preferences
   - "API SDK 비용 우려로 Claude Code 세션 스폰 방식 선호" ✅
5. **Commitments / ownership**: who will do what
   - "인증 모듈은 CEO가 직접 처리하기로 결정" ✅
6. **Corrections / updates**: explicit change to prior knowledge
   - "중복 임계값 0.85에서 0.90으로 상향 조정" ✅
7. **Surprising failures**: unexpected outcomes worth avoiding next time
   - "Turbopack에서 extensionAlias 미지원으로 webpack 설정 충돌 발생" ✅

## SKIP (shouldStore: false) — these are NOISE

1. **Process narration**: "확인 중", "조사하겠습니다", "시작했다", "진행 중", "커밋 완료"
2. **Meta-descriptions without substance**: "SnoopDuck 요청", "Claude가 계획을 세움", "Codex가 리뷰 수행"
   - Ask yourself: "요청한 게 뭔데? 계획이 뭔데? 리뷰 결과가 뭔데?" → if no answer, SKIP
3. **Routine confirmations**: "OK", "ㅇㅇ" (after casual chat), "알겠습니다", "진행해"
4. **Intermediate deliberation**: "A할까 B할까?" → SKIP (only store the FINAL choice)
5. **Repetition of known facts**: if it's already common knowledge or was decided before, SKIP
6. **Completed one-off tasks**: "npm install 완료", "파일 생성함", "테스트 통과" → ephemeral, SKIP
7. **Agent status updates**: "Claude/Codex: 확인했습니다", "검증 완료", "reviewing now"
8. **Emotional reactions without content**: "짜증나", "좋아!", "대박" → no extractable knowledge

## The "6-Month Test"

Before storing, ask: "6개월 후에 이 정보가 필요할까?"
- "LanceDB를 벡터DB로 확정" → YES, 6개월 후에도 이 아키텍처 결정을 알아야 함
- "SnoopDuck 지시에 따라 리뷰 수행" → NO, 누가 뭘 시켰는지는 내일도 불필요
- "커밋 완료" → NO, 커밋은 git log에 있음

## distilled text rules

- Extract the KNOWLEDGE, not describe the conversation event
- BAD: "SnoopDuck 요청하여 조사 수행" → WHO requested WHAT investigation about WHAT?
- BAD: "Claude가 구현 계획을 작성함" → WHAT plan? WHAT will be implemented?
- BAD: "Codex 리뷰 완료" → WHAT was the finding?
- GOOD: "환불 로직에서 위약금은 계약일 기준 30일 이내면 면제"
- GOOD: "SDK resume 시 sessionId와 resume을 동시에 쓰면 크래시 — resume만 단독 사용해야 함"
- GOOD: "PM2로 메모리 MCP 서버를 별도 프로세스로 실행하기로 확정"
- Max 200 chars, 1-2 sentences
- Write in the SAME LANGUAGE as the original message (Korean or English)
- NEVER output Chinese or Japanese text

## Fields

- kind: fact | task | observation | proposal | feedback | dialog_summary | decision
- priority: 0-10 (10 = critical architecture decision, 0 = trivial)
- topicKey: short English tag (e.g., "vector-db", "session-recovery"). Reuse existing keys when possible.
- speaker: who MADE the decision (user/claude/codex/system), not who spoke the current message
- memoryAction: "create" (new info) or "update" (corrects/changes existing info)
  - Update signals: "→", "에서...로", "변경", "정정", "취소", "수정", "아니고", "대신", "instead", "renamed", "actually"
  - Default to "create" if unsure
- updateConfidence: 0.0-1.0
- anchorTerms: key entities (names, file paths, numbers, dates, tool names)

## Response format

Respond ONLY with valid JSON (no markdown, no explanation):
{"shouldStore": boolean, "distilled": "string", "kind": "string", "priority": number, "topicKey": "string", "speaker": "string", "memoryAction": "create"|"update", "updateConfidence": number, "anchorTerms": ["string"]}

Example STORE:
{"shouldStore": true, "distilled": "벡터DB를 LanceDB로 확정, 임베딩은 Ollama qwen3-embedding:4b 사용", "kind": "decision", "priority": 8, "topicKey": "vector-db", "speaker": "user", "memoryAction": "create", "updateConfidence": 0.0, "anchorTerms": ["LanceDB", "qwen3-embedding"]}

Example SKIP:
{"shouldStore": false, "distilled": "", "kind": "observation", "priority": 0, "topicKey": "", "speaker": "system", "memoryAction": "create", "updateConfidence": 0.0, "anchorTerms": []}

IMPORTANT: Always include ALL 9 fields.`;

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

export interface BatchDistillItem {
  id: number;
  message: { speaker: string; content: string; timestamp: string };
  context: SlidingMessage[];
  existingTopicKeys?: string[];
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
      let results = this.parseBatchResponse(raw, items);
      if (results) {
        log.info({ count: items.length, stored: results.filter(r => r.result.shouldStore).length }, 'Batch distill complete');

        // 2nd pass: review task classifications against originals
        results = await this.reviewTaskClassifications(results, items, messages);

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
   * 2nd-pass review: verify that items classified as "task" are truly
   * unfinished future work, not completion reports or ephemeral instructions.
   * Uses the same SDK session (cache-warm) for a cheap follow-up turn.
   */
  private async reviewTaskClassifications(
    results: BatchDistillResult[],
    items: BatchDistillItem[],
    priorMessages: ChatMessage[],
  ): Promise<BatchDistillResult[]> {
    // Find task candidates to review
    const taskResults = results.filter(
      (r) => r.result.shouldStore && r.result.kind === 'task',
    );
    if (taskResults.length === 0) return results;

    // Build review prompt with original messages + classifications
    const reviewItems = taskResults.map((tr) => {
      const original = items.find((i) => i.id === tr.id);
      return {
        id: tr.id,
        original: original ? `${original.message.speaker}: ${original.message.content}` : '(not found)',
        distilled: tr.result.distilled,
        kind: tr.result.kind,
        priority: tr.result.priority,
      };
    });

    const reviewPrompt = `Review your task classifications. For each item below, check if it's TRULY an unfinished future task, or actually a completion report / status update / ephemeral instruction that was misclassified.

Items to review:
${JSON.stringify(reviewItems, null, 2)}

Rules:
- A "task" must be UNFINISHED FUTURE WORK that someone still needs to do
- "리태깅 완료 412건" → NOT a task, it's a fact (completion report)
- "서버 재시작해줘" → NOT a task, it's an ephemeral instruction (skip)
- "interruptSession 수정 필요" → YES, this is a real task
- "커밋 완료" → NOT a task (skip)

For each item, respond with ONE of:
- "keep" = correct, it's a real unfinished task
- "fact" = misclassified, should be kind=fact (completion report / result)
- "skip" = should not be stored (ephemeral / noise)

Respond ONLY with a JSON array: [{"id": 0, "verdict": "keep|fact|skip"}, ...]`;

    try {
      const reviewMessages: ChatMessage[] = [
        ...priorMessages,
        { role: 'user', content: reviewPrompt },
      ];
      const reviewRaw = await this.chat.chat(reviewMessages);

      // Parse review response
      let jsonStr = reviewRaw.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

      const verdicts: Array<{ id: number; verdict: string }> = JSON.parse(jsonStr);
      let corrected = 0;

      for (const v of verdicts) {
        const target = results.find((r) => r.id === v.id);
        if (!target) continue;

        if (v.verdict === 'fact') {
          target.result.kind = 'fact';
          corrected++;
          log.info({ id: v.id, text: target.result.distilled.slice(0, 60) }, 'Review: task → fact');
        } else if (v.verdict === 'skip') {
          target.result.shouldStore = false;
          corrected++;
          log.info({ id: v.id, text: target.result.distilled.slice(0, 60) }, 'Review: task → skip');
        }
      }

      if (corrected > 0) {
        log.info({ reviewed: taskResults.length, corrected }, 'Task review pass complete');
      }
    } catch (err) {
      log.warn({ err }, 'Task review pass failed, keeping original classifications');
    }

    return results;
  }

  private buildBatchPrompt(items: BatchDistillItem[]): string {
    // Collect all unique topicKeys across items
    const allTopicKeys = new Set<string>();
    for (const item of items) {
      if (item.existingTopicKeys) {
        for (const k of item.existingTopicKeys) allTopicKeys.add(k);
      }
    }

    const batch = items.map((item) => {
      const contextLines = item.context.map((m) => `${m.speaker}: ${m.content}`);
      return {
        id: item.id,
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

    prompt += `\nRespond with a JSON array: [{"id": 0, "shouldStore": ..., "distilled": ..., "kind": ..., "priority": ..., "topicKey": ..., "speaker": ..., "memoryAction": ..., "updateConfidence": ..., "anchorTerms": [...]}, ...]`;
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
    const results: BatchDistillResult[] = [];
    for (const item of items) {
      const result = await this.distill({
        message: item.message,
        context: item.context,
        existingTopicKeys: item.existingTopicKeys,
      });
      results.push({ id: item.id, result });
    }
    return results;
  }

  async distill(input: DistillInput): Promise<DistillResult> {
    const userPrompt = this.buildUserPrompt(input);
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
      const rawAction = parsed.memoryAction === 'update' ? 'update' : 'create';
      const updateConfidence = typeof parsed.updateConfidence === 'number'
        ? Math.max(0, Math.min(1, parsed.updateConfidence)) : 0;
      const anchorTerms = Array.isArray(parsed.anchorTerms)
        ? parsed.anchorTerms.filter((t: unknown) => typeof t === 'string' && (t as string).length > 0)
        : [];

      // Rule gate: validate "update" action with signal patterns
      let memoryAction: 'create' | 'update' = 'create';
      if (rawAction === 'update' && updateConfidence >= 0.8) {
        const updateSignals = /->|→|에서\s.*로|변경|정정|바뀜|확정|취소|수정|오타|아니고|아니라|대신|말고|actually|instead|renamed|moved to|not\s.*but/i;
        if (updateSignals.test(parsed.distilled) || updateConfidence >= 0.95) {
          memoryAction = 'update';
        }
      }

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
        },
        cjkRejected: false,
      };
    } catch {
      return { result: null, cjkRejected: false };
    }
  }
}
