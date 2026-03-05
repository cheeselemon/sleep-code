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
}

export interface DistillResult {
  shouldStore: boolean;
  distilled: string;
  kind: MemoryKind;
  priority: number;
  topicKey: string;
}

// ── Prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a memory classifier for an AI butler system.
Your job is to decide whether a message in a conversation is worth remembering long-term.

Rules:
- Decisions, preferences, facts, feedback, task assignments = REMEMBER (shouldStore: true)
- Casual chat, greetings, simple acknowledgments = JUDGE BY CONTEXT
  - "ㅇㅇ" after "이거 LanceDB로 할까?" = decision confirmation → REMEMBER
  - "ㅇㅇ" after "밥 먹었어?" = casual → SKIP
- Agent (Claude/Codex) progress reports = SKIP (e.g., "확인 중", "시작했다", "검증 완료", "reviewing now")
  - Only store agent messages if they contain a NEW decision, finding, or recommendation
- Keep the original language (Korean/English) in distilled text
- NEVER output Chinese or Japanese text. Always write in Korean or English.
- kind must be one of: fact, task, observation, proposal, feedback, dialog_summary, decision
- priority: 0-10 (10 = critical decision, 0 = trivial)
- topicKey: short topic tag in English (e.g., "vector-db", "refund-logic", "api-cost")

CRITICAL - distilled text rules:
- distilled MUST contain the SPECIFIC SUBSTANCE of the decision/fact, not a meta-description
- BAD: "SnoopDuck 요청. 업데이트 후 코덱스와 논의" (what was requested? what update?)
- GOOD: "환불 로직에서 위약금은 계약일 기준 30일 이내면 면제하기로 결정"
- BAD: "Claude confirmed the plan" (what plan?)
- GOOD: "LanceDB를 벡터DB로 사용하고, Ollama로 로컬 임베딩 처리하기로 확정"
- Include WHO decided/said WHAT about WHICH topic
- Max 200 chars, 1-2 sentences

Respond ONLY with valid JSON matching this EXACT schema (use these EXACT field names):
{"shouldStore": boolean, "distilled": "string", "kind": "string", "priority": number, "topicKey": "string"}

Example — worth remembering:
{"shouldStore": true, "distilled": "LanceDB를 벡터DB로 사용하기로 확정", "kind": "decision", "priority": 7, "topicKey": "vector-db"}

Example — not worth remembering:
{"shouldStore": false, "distilled": "", "kind": "observation", "priority": 0, "topicKey": ""}

IMPORTANT: Always include ALL 5 fields. Field name must be "shouldStore", not "remember" or "should_remember".`;

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

export class DistillService {
  private chat: ChatService;

  constructor(chat: ChatService) {
    this.chat = chat;
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
    prompt += `\n\nShould this message be remembered? Respond with JSON only.`;

    return prompt;
  }

  private parseResponse(raw: string): ParseResult {
    try {
      const parsed = JSON.parse(raw.trim());

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

      // Detect CJK language errors (Chinese/Japanese without Korean) → signal retry
      if (hasCJKWithoutKorean(parsed.distilled)) {
        return { result: null, cjkRejected: true };
      }

      if (!VALID_KINDS.has(parsed.kind)) return { result: null, cjkRejected: false };

      const priority = Number(parsed.priority);
      if (isNaN(priority) || priority < 0 || priority > 10) return { result: null, cjkRejected: false };

      return {
        result: {
          shouldStore: true,
          distilled: parsed.distilled.slice(0, 200),
          kind: parsed.kind as MemoryKind,
          priority: Math.round(priority),
          topicKey: typeof parsed.topicKey === 'string' ? parsed.topicKey : '',
        },
        cjkRejected: false,
      };
    } catch {
      return { result: null, cjkRejected: false };
    }
  }
}
