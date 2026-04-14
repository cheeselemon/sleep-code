import type { AgentSessionEntry, AgentEvents } from './agent-session-manager.js';
import { appendCompactionMarker } from './session-history.js';
import { discordLogger as log } from '../../utils/logger.js';

const COMPACT_THRESHOLD = 0.85;  // 컨텍스트의 85% 도달 시
const MAX_CONSECUTIVE_FAILURES = 3;

let consecutiveFailures = 0;

function estimateTokens(messages: Array<{ role: string; content?: string | null }>): number {
  let total = 0;
  for (const msg of messages) {
    total += 4;  // 메시지 오버헤드
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4);
    }
    // tool_calls의 arguments도 카운트
    if ('tool_calls' in msg && Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls) {
        total += Math.ceil((tc.function?.arguments?.length || 0) / 4);
      }
    }
  }
  return total;
}

export async function autoCompact(
  session: AgentSessionEntry,
  events: AgentEvents,
): Promise<boolean> {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;

  const estimated = estimateTokens(session.conversationHistory as any);
  const threshold = session.modelDef.contextWindow * COMPACT_THRESHOLD;

  if (estimated < threshold) return false;

  log.info({
    sessionId: session.id,
    estimated,
    threshold,
    contextWindow: session.modelDef.contextWindow,
  }, 'Auto-compaction triggered');

  try {
    // 시스템 프롬프트는 유지, 나머지 중 앞쪽 절반을 요약
    const systemMsg = session.conversationHistory[0];  // system prompt
    const messages = session.conversationHistory.slice(1);
    const halfIdx = Math.floor(messages.length / 2);
    const toCompact = messages.slice(0, halfIdx);
    const toKeep = messages.slice(halfIdx);

    if (toCompact.length < 2) return false;  // 너무 적으면 스킵

    // 요약 요청
    const summaryResponse = await session.openaiClient.chat.completions.create({
      model: session.modelDef.apiId,
      messages: [
        {
          role: 'system',
          content: 'Summarize the following conversation concisely. Focus on: decisions made, code changes, current task state, and unresolved questions. Output only the summary.',
        },
        ...toCompact as any,
      ],
      max_tokens: 2000,
    });

    const summary = summaryResponse.choices[0]?.message?.content || '';
    if (!summary) {
      consecutiveFailures++;
      return false;
    }

    // 히스토리 교체
    session.conversationHistory = [
      systemMsg,
      { role: 'system', content: `[Conversation summary]\n${summary}` },
      ...toKeep,
    ];

    // JSONL에 마커 기록
    await appendCompactionMarker(session.id, summary, halfIdx);
    consecutiveFailures = 0;

    await events.onCompaction(session.id);
    log.info({
      sessionId: session.id,
      compacted: toCompact.length,
      remaining: toKeep.length + 2,
    }, 'Auto-compaction complete');

    return true;
  } catch (err) {
    consecutiveFailures++;
    log.error({ sessionId: session.id, err, failures: consecutiveFailures }, 'Auto-compaction failed');
    return false;
  }
}
