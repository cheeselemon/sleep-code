import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const SESSIONS_DIR = join(homedir(), '.sleep-code', 'agent-sessions');

interface HistoryEntry {
  type: 'system' | 'user' | 'assistant' | 'tool' | 'compaction';
  message: ChatCompletionMessageParam;
  timestamp: string;
  // compaction 전용
  compactedUpTo?: number;  // 이 인덱스까지 compaction됨
}

export async function ensureSessionsDir(): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) {
    await mkdir(SESSIONS_DIR, { recursive: true });
  }
}

export async function appendToHistory(
  sessionId: string,
  message: ChatCompletionMessageParam,
  type?: string,
): Promise<void> {
  await ensureSessionsDir();
  const entry: HistoryEntry = {
    type: (type || message.role) as HistoryEntry['type'],
    message,
    timestamp: new Date().toISOString(),
  };
  const filepath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  await appendFile(filepath, JSON.stringify(entry) + '\n');
}

export async function appendCompactionMarker(
  sessionId: string,
  summary: string,
  compactedUpTo: number,
): Promise<void> {
  await ensureSessionsDir();
  const entry: HistoryEntry = {
    type: 'compaction',
    message: { role: 'system', content: `[Compacted conversation summary]\n${summary}` },
    timestamp: new Date().toISOString(),
    compactedUpTo,
  };
  const filepath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  await appendFile(filepath, JSON.stringify(entry) + '\n');
}

export async function loadHistory(sessionId: string): Promise<ChatCompletionMessageParam[]> {
  const filepath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(filepath)) return [];

  const content = await readFile(filepath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const entries: HistoryEntry[] = lines.map(l => JSON.parse(l));

  // 마지막 compaction 마커 이후의 메시지만 사용
  let startIdx = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'compaction') {
      // compaction 마커의 system 메시지 + 이후 메시지
      startIdx = i;
      break;
    }
  }

  return entries.slice(startIdx).map(e => e.message);
}
