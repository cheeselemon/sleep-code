/**
 * Liveness telemetry helpers — shared between `/status` modes.
 *
 * Born from a Codex silent-hang incident (session a9c9f5f1, 8h+ no events). The
 * primary purpose is "is anything wedged right now and how long has it been
 * wedged?" so triage doesn't require ssh + pm2 logs grep.
 *
 * Two consumers:
 *   - `/status` outside a session thread → renders the full multi-section view
 *     via `renderGlobalLiveness()` (was the old `/check-alive` body)
 *   - `/status` inside a session thread → enriches each per-agent block with
 *     `formatCodexLiveness()` / `formatSdkLiveness()` / `formatAgentLiveness()`
 *     so the same hang markers and event-age data show up alongside the
 *     thread-scoped detail
 *
 * Constants here mirror `CODEX_IDLE_WARN_MS` / `CODEX_IDLE_ABORT_MS` in
 * codex-session-manager.ts. Kept as literals to avoid an import cycle — keep
 * them in lockstep when watchdog tuning changes.
 */

import { codeBlock } from 'discord.js';
import type { ChannelManager } from '../channel-manager.js';
import type { ClaudeSdkSessionManager, ClaudeSdkSessionEntry } from '../claude-sdk/claude-sdk-session-manager.js';
import type { CodexSessionManager, CodexSessionEntry } from '../codex/codex-session-manager.js';
import type { AgentSessionManager, AgentSessionEntry } from '../agents/agent-session-manager.js';

export const CODEX_IDLE_WARN_SEC = 90;
export const CODEX_IDLE_ABORT_SEC = 600;

const STATUS_ICON: Record<string, string> = {
  running: '🟢',
  idle: '⚪',
  starting: '🟡',
  ended: '⚫',
};

export function fmtAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

function fmtPrefix(id: string): string {
  return id.length >= 8 ? id.slice(0, 8) : id;
}

/**
 * Codex hang marker — encodes the watchdog state purely from observed
 * `lastEventAt` so display logic doesn't have to know the watchdog runs
 * inside the manager. Returns empty string when healthy.
 */
export function codexHangMarker(s: CodexSessionEntry, nowMs = Date.now()): string {
  const turnInFlight = s.turnStartedAt !== null;
  if (!turnInFlight) return '';
  const idleSec = Math.round((nowMs - s.lastEventAt.getTime()) / 1000);
  if (idleSec >= CODEX_IDLE_ABORT_SEC) return ' 🚨 SILENT HANG';
  if (idleSec >= CODEX_IDLE_WARN_SEC) return ' ⚠️ idle';
  return '';
}

/**
 * Single-line Codex liveness snapshot — used both in the global view and
 * inline in the thread-scoped /status. `compact` returns just the data block
 * (no leading status icon / id prefix) for embedding into existing blocks.
 */
export function formatCodexLiveness(s: CodexSessionEntry, opts?: { compact?: boolean; nowMs?: number }): string {
  const nowMs = opts?.nowMs ?? Date.now();
  const ageMs = nowMs - s.startedAt.getTime();
  const idleMs = nowMs - s.lastEventAt.getTime();
  const idleSec = Math.round(idleMs / 1000);
  const turnInFlight = s.turnStartedAt !== null;
  const turnAgeMs = s.turnStartedAt ? nowMs - s.turnStartedAt.getTime() : 0;
  const lastEvt = s.lastEventType ?? 'none';
  const queue = s.inputQueue.length > 0 ? ` · queue ${s.inputQueue.length}` : '';
  const turnInfo = turnInFlight ? ` · turn ${fmtAge(turnAgeMs)}` : '';
  const data = `age ${fmtAge(ageMs)}${turnInfo} · last evt \`${lastEvt}\` (${idleSec}s ago) · evts ${s.eventsTotal}${queue}`;

  if (opts?.compact) return data;

  const icon = STATUS_ICON[s.status] ?? '❓';
  return (
    `${icon} \`${fmtPrefix(s.id)}\` · ${s.status} · ${s.model}/${s.modelReasoningEffort}${codexHangMarker(s, nowMs)}\n` +
    `   ${data} · <#${s.discordThreadId}>`
  );
}

export function formatSdkLiveness(s: ClaudeSdkSessionEntry, opts?: { compact?: boolean; nowMs?: number }): string {
  const nowMs = opts?.nowMs ?? Date.now();
  const ageMs = nowMs - s.startedAt.getTime();
  const queue = s.inputQueue.length > 0 ? ` · queue ${s.inputQueue.length}` : '';
  const model = s.selectedModel ? ` · ${s.selectedModel}` : '';
  const data = `age ${fmtAge(ageMs)}${queue}`;
  if (opts?.compact) return data;
  const icon = STATUS_ICON[s.status] ?? '❓';
  return `${icon} \`${fmtPrefix(s.id)}\` · ${s.status}${model} · ${data} · <#${s.discordThreadId}>`;
}

export function formatAgentLiveness(s: AgentSessionEntry, opts?: { compact?: boolean; nowMs?: number }): string {
  const nowMs = opts?.nowMs ?? Date.now();
  const ageMs = nowMs - s.startedAt.getTime();
  const data = `age ${fmtAge(ageMs)} · turns ${s.turnCount} · $${s.totalCostUSD.toFixed(4)}`;
  if (opts?.compact) return data;
  const icon = STATUS_ICON[s.status] ?? '❓';
  return `${icon} \`${fmtPrefix(s.id)}\` · ${s.status} · ${s.modelAlias} · ${data} · <#${s.discordThreadId}>`;
}

/**
 * Format process uptime in a human-friendly form.
 */
export function fmtUptime(uptimeSec: number): string {
  if (uptimeSec < 60) return `${Math.floor(uptimeSec)}s`;
  const min = Math.floor(uptimeSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return `${hr}h${remMin}m`;
  const day = Math.floor(hr / 24);
  return `${day}d${hr % 24}h`;
}

/**
 * Format bytes to MB with one decimal.
 */
export function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}

/**
 * Build the system header (timestamp + bot uptime + memory + Node version).
 * Used by both `/status` modes.
 */
export function renderSystemHeader(): string {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  return (
    `📊 **System** — ${ts} KST\n` +
    `PID \`${process.pid}\` · uptime ${fmtUptime(uptime)} · ` +
    `RSS ${fmtMB(mem.rss)} · heap ${fmtMB(mem.heapUsed)}/${fmtMB(mem.heapTotal)} · ` +
    `Node ${process.version}`
  );
}

/**
 * Global liveness view — used by `/status` when invoked outside a session thread.
 * Returns a Discord-ready string (≤ ~1900 chars) or `null` if no sessions.
 */
export function renderGlobalLiveness(deps: {
  channelManager: ChannelManager;
  codexSessionManager?: CodexSessionManager;
  claudeSdkSessionManager?: ClaudeSdkSessionManager;
  agentSessionManager?: AgentSessionManager;
}): string | null {
  const { channelManager, codexSessionManager, claudeSdkSessionManager, agentSessionManager } = deps;
  const now = Date.now();
  const sections: string[] = [];

  // ── Claude PTY sessions ─────────────────────────────────────────
  const ptyActive = channelManager.getAllActive();
  if (ptyActive.length > 0) {
    const lines: string[] = [];
    for (const m of ptyActive) {
      const icon = STATUS_ICON[m.status] ?? '❓';
      const ageMs = now - new Date(m.createdAt).getTime();
      lines.push(
        `${icon} \`${fmtPrefix(m.sessionId)}\` · ${m.status} · age ${fmtAge(ageMs)} · <#${m.threadId}>`,
      );
    }
    sections.push(`**Claude PTY** (${ptyActive.length})\n${lines.join('\n')}`);
  }

  // ── Claude SDK sessions ─────────────────────────────────────────
  const sdkSessions = claudeSdkSessionManager?.getAllSessions().filter(s => s.status !== 'ended') ?? [];
  if (sdkSessions.length > 0) {
    const lines = sdkSessions.map(s => formatSdkLiveness(s, { nowMs: now }));
    sections.push(`**Claude SDK** (${sdkSessions.length})\n${lines.join('\n')}`);
  }

  // ── Codex sessions (richest telemetry) ──────────────────────────
  const codexSessions = codexSessionManager?.getAllSessions().filter(s => s.status !== 'ended') ?? [];
  if (codexSessions.length > 0) {
    const lines = codexSessions.map(s => formatCodexLiveness(s, { nowMs: now }));
    sections.push(`**Codex** (${codexSessions.length})\n${lines.join('\n')}`);
  }

  // ── Agent sessions ──────────────────────────────────────────────
  const agentSessions = agentSessionManager?.getAllSessions().filter(s => s.status !== 'ended') ?? [];
  if (agentSessions.length > 0) {
    const lines = agentSessions.map(s => formatAgentLiveness(s, { nowMs: now }));
    sections.push(`**Agents** (${agentSessions.length})\n${lines.join('\n')}`);
  }

  if (sections.length === 0) return null;

  const header = `🩺 **Liveness** — ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`;
  const legend =
    '_Legend: 🟢 running · ⚪ idle · 🟡 starting · ⚫ ended · ' +
    `⚠️ idle ≥${CODEX_IDLE_WARN_SEC}s · 🚨 silent-hang ≥${CODEX_IDLE_ABORT_SEC}s_`;
  const body = sections.join('\n\n');
  const message = `${header}\n${legend}\n\n${body}`;

  if (message.length <= 1900) return message;
  // Oversized — strip bold and clip into a code block.
  const plain = sections.map(s => s.replace(/\*\*/g, '')).join('\n\n');
  return `${header}\n${legend}\n\n${codeBlock(plain.slice(0, 1800))}`;
}
