/**
 * /status — smart overview command.
 *
 * Two modes:
 *   1. Inside a session thread → per-session detail (PID, socket, sandbox, model)
 *      enriched with liveness telemetry (Codex hang marker, last-event age, queue),
 *      followed by a compact "Other sessions" footer for quick global awareness.
 *   2. Outside a session thread → comprehensive system overview:
 *        - System header (PID, uptime, RSS, Node version)
 *        - Active sessions across PTY / SDK / Codex / Agent (with liveness)
 *        - State summary (YOLO count, routing thread count)
 *        - Memory pipeline status (distill queue, global enabled, opted-out count, digest runner)
 *        - Settings summary (allowed dirs, terminal app, max concurrent)
 *
 * Liveness rendering lives in `./liveness.ts` so both modes share format + thresholds.
 */

import { EmbedBuilder } from 'discord.js';
import { basename } from 'path';
import { MAX_AGENT_ROUTING } from '../state.js';
import type { CommandHandler } from './types.js';
import {
  renderGlobalLiveness,
  renderSystemHeader,
  formatCodexLiveness,
  formatSdkLiveness,
  formatAgentLiveness,
  codexHangMarker,
  fmtAge,
  CODEX_IDLE_WARN_SEC,
  CODEX_IDLE_ABORT_SEC,
} from './liveness.js';

const STATUS_EMOJI: Record<string, string> = {
  running: '🟢',
  idle: '🔵',
  starting: '🔄',
  stopping: '🟡',
  stopped: '⚫',
  orphaned: '🔴',
  ended: '⚫',
};

export const handleStatus: CommandHandler = async (interaction, context) => {
  const {
    channelManager,
    sessionManager,
    processManager,
    settingsManager,
    codexSessionManager,
    claudeSdkSessionManager,
    agentSessionManager,
    batchDistillRunner,
    dailyDigestRunner,
    state,
  } = context;

  // ── Mode 1: outside a thread → comprehensive system overview ──────
  if (!interaction.channel?.isThread()) {
    const sections: string[] = [renderSystemHeader()];

    const liveness = renderGlobalLiveness({
      channelManager,
      codexSessionManager,
      claudeSdkSessionManager,
      agentSessionManager,
    });
    if (liveness) {
      sections.push(liveness);
    } else {
      sections.push('🤖 **Sessions** — none active');
    }

    sections.push(renderStateSummary(state));

    const memorySummary = renderMemorySummary(batchDistillRunner, dailyDigestRunner);
    if (memorySummary) sections.push(memorySummary);

    if (settingsManager) sections.push(renderSettingsSummary(settingsManager));

    sections.push(renderLegend());

    const message = sections.join('\n\n');
    // Discord 2000-char hard limit; trim from the bottom (legend + settings) if needed.
    const safe = message.length > 1950 ? message.slice(0, 1900) + '\n\n_…(truncated)_' : message;
    await interaction.reply({ content: safe, ephemeral: true });
    return;
  }

  // ── Mode 2: inside a thread → per-session detail + footer ────────
  const threadId = interaction.channelId;
  const agents = channelManager.getAgentsInThread(threadId);
  const agentSession = agentSessionManager?.getSessionByDiscordThread(threadId);
  const sdkSession =
    claudeSdkSessionManager?.getSessionByThread?.(threadId) ??
    claudeSdkSessionManager?.getAllSessions().find(
      s => s.discordThreadId === threadId && s.status !== 'ended',
    );

  // Empty thread → fall through to the global overview so the operator gets
  // useful telemetry instead of a dead-end "no session" reply.
  if (!agents.claude && !agents.codex && !agentSession && !sdkSession) {
    const sections: string[] = [renderSystemHeader()];
    const liveness = renderGlobalLiveness({
      channelManager,
      codexSessionManager,
      claudeSdkSessionManager,
      agentSessionManager,
    });
    sections.push(liveness ?? '🤖 **Sessions** — none active');
    sections.push(renderStateSummary(state));
    const memorySummary = renderMemorySummary(batchDistillRunner, dailyDigestRunner);
    if (memorySummary) sections.push(memorySummary);
    sections.push(renderLegend());
    sections.push('_No session in this thread — showing global overview._');
    const message = sections.join('\n\n');
    const safe = message.length > 1950 ? message.slice(0, 1900) + '\n\n_…(truncated)_' : message;
    await interaction.reply({ content: safe, ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder().setTitle('📊 Thread Status').setColor(0x00AE86);

  const lines: string[] = [];

  // ── Claude PTY ───────────────────────────────────────────────
  if (agents.claude) {
    const channelMapping = channelManager.getSession(agents.claude);
    const processEntry = await processManager?.getEntry(agents.claude);
    const socketSession = sessionManager.getSession(agents.claude);

    const channelStatus = channelMapping?.status ?? 'unknown';
    const processStatus = processEntry?.status ?? channelStatus;
    const emoji = STATUS_EMOJI[processStatus] ?? '❓';
    const pid = processEntry?.pid && processEntry.pid > 0 ? processEntry.pid : '—';
    const socket = socketSession ? '✅ connected' : '❌ disconnected';
    const cwd = channelMapping?.cwd ? basename(channelMapping.cwd) : '—';
    const ageMs = channelMapping ? Date.now() - new Date(channelMapping.createdAt).getTime() : 0;

    lines.push(`**Claude PTY** ${emoji} ${processStatus}`);
    lines.push(`  Session: \`${agents.claude.slice(0, 8)}\` · Age: ${fmtAge(ageMs)}`);
    lines.push(`  PID: \`${pid}\` · Socket: ${socket}`);
    lines.push(`  Directory: \`${cwd}\``);
    lines.push('');
  }

  // ── Claude SDK ───────────────────────────────────────────────
  if (sdkSession) {
    const emoji = STATUS_EMOJI[sdkSession.status] ?? '❓';
    const cwd = sdkSession.cwd ? basename(sdkSession.cwd) : '—';
    const model = sdkSession.selectedModel ?? '(default)';

    lines.push(`**Claude SDK** ${emoji} ${sdkSession.status}`);
    lines.push(`  Session: \`${sdkSession.id.slice(0, 8)}\``);
    lines.push(`  Model: \`${model}\``);
    lines.push(`  Directory: \`${cwd}\``);
    lines.push(`  Liveness: ${formatSdkLiveness(sdkSession, { compact: true })}`);
    lines.push('');
  }

  // ── Codex (richest liveness data) ────────────────────────────
  if (agents.codex && codexSessionManager) {
    const codexSession = codexSessionManager.getSession(agents.codex);
    const status = codexSession?.status ?? 'unknown';
    const emoji = STATUS_EMOJI[status] ?? '❓';
    const sandbox = codexSession?.sandboxMode ?? '—';
    const marker = codexSession ? codexHangMarker(codexSession) : '';

    lines.push(`**Codex** ${emoji} ${status}${marker}`);
    lines.push(`  Session: \`${agents.codex.slice(0, 8)}\``);
    lines.push(`  Sandbox: \`${sandbox}\``);
    if (codexSession) {
      lines.push(`  Model: \`${codexSession.model}/${codexSession.modelReasoningEffort}\``);
      lines.push(`  Liveness: ${formatCodexLiveness(codexSession, { compact: true })}`);
    }
    lines.push('');
  }

  // ── Agent (OpenRouter / DeepInfra) ───────────────────────────
  if (agentSession) {
    const status = agentSession.status ?? 'unknown';
    const emoji = STATUS_EMOJI[status] ?? '❓';
    const model = agentSession.modelDef.displayName;
    const cwd = agentSession.cwd ? basename(agentSession.cwd) : '—';

    lines.push(`**${model}** ${emoji} ${status}`);
    lines.push(`  Session: \`${agentSession.id.slice(0, 8)}\``);
    lines.push(`  Directory: \`${cwd}\``);
    lines.push(`  Liveness: ${formatAgentLiveness(agentSession, { compact: true })}`);
    lines.push('');
  }

  // ── This-thread shared state ─────────────────────────────────
  const yolo =
    (agents.claude && state.yoloSessions.has(agents.claude)) ||
    (agentSession && state.yoloSessions.has(agentSession.id)) ||
    (sdkSession && state.yoloSessions.has(sdkSession.id));
  const lastActive = state.lastActiveAgent.get(threadId) ?? '—';
  const routingCount = state.agentRoutingCount.get(threadId) ?? 0;
  const memoryOptedOut = batchDistillRunner?.isOptedOut(threadId) ?? false;

  lines.push(`YOLO: ${yolo ? '🔥 ON' : '🛡️ OFF'}`);
  lines.push(`Memory: ${memoryOptedOut ? '🔇 opted-out' : '🧠 collecting'}`);
  lines.push(`Last active agent: **${lastActive}**`);
  lines.push(`Routing: \`${routingCount}/${MAX_AGENT_ROUTING}\``);

  embed.setDescription(lines.join('\n'));

  // ── "Other sessions" footer for quick global awareness ───────
  const footer = renderOtherSessionsFooter({
    threadId,
    channelManager,
    codexSessionManager,
    claudeSdkSessionManager,
    agentSessionManager,
  });
  if (footer) {
    embed.addFields({ name: 'Other Sessions', value: footer.slice(0, 1024), inline: false });
  }

  // System line (compact, not the full header — embed has limited space)
  const mem = process.memoryUsage();
  embed.setFooter({
    text:
      `PID ${process.pid} · uptime ${fmtUptimeShort(process.uptime())} · RSS ${(mem.rss / 1024 / 1024).toFixed(0)}MB · ` +
      `legend: ⚠️≥${CODEX_IDLE_WARN_SEC}s · 🚨≥${CODEX_IDLE_ABORT_SEC}s`,
  });

  await interaction.reply({ embeds: [embed], ephemeral: true });
};

// ─────────────────────────────────────────────────────────────────────
//  Section renderers
// ─────────────────────────────────────────────────────────────────────

function renderStateSummary(state: import('../state.js').DiscordState): string {
  const yoloCount = state.yoloSessions.size;
  const routingThreads = Array.from(state.agentRoutingCount.entries()).filter(([, n]) => n > 0).length;
  const pendingPerm = state.pendingPermissions.size;
  const pendingQuestions = state.pendingQuestions.size;
  const typing = state.typingIntervals.size;

  return (
    `⚙️ **State**\n` +
    `YOLO: ${yoloCount > 0 ? `🔥 ${yoloCount} session(s)` : '🛡️ none'} · ` +
    `Routing threads: ${routingThreads} (max ${MAX_AGENT_ROUTING}/thread)\n` +
    `Pending permissions: ${pendingPerm} · Pending questions: ${pendingQuestions} · Typing indicators: ${typing}`
  );
}

function renderMemorySummary(
  runner: import('../../memory/batch-distill-runner.js').BatchDistillRunner | undefined,
  digest: import('../../memory/daily-digest.js').DailyDigestRunner | undefined,
): string | null {
  if (!runner && !digest) return null;
  const lines: string[] = ['🧠 **Memory**'];
  if (runner) {
    const enabled = runner.isGlobalEnabled ? '🟢 enabled' : '🔴 disabled';
    const running = runner.isRunning ? 'running' : 'stopped';
    lines.push(
      `Distill: ${enabled} · ${running} · queue ${runner.queueLength} · ` +
      `opted-out threads: ${runner.optedOutCount}`,
    );
  }
  if (digest) {
    lines.push(`Daily digest runner: ✅ active`);
  }
  return lines.join('\n');
}

function renderSettingsSummary(
  sm: import('../settings-manager.js').SettingsManager,
): string {
  const dirs = sm.getAllowedDirectories();
  const term = sm.getTerminalApp();
  const max = sm.getMaxSessions();
  return (
    `📁 **Settings**\n` +
    `Allowed dirs: ${dirs.length} · Terminal: \`${term}\` · ` +
    `Max concurrent: ${max ?? '∞'}`
  );
}

function renderLegend(): string {
  return (
    '_Legend: 🟢 running · ⚪ idle · 🟡 starting · ⚫ ended · ' +
    `⚠️ idle ≥${CODEX_IDLE_WARN_SEC}s · 🚨 silent-hang ≥${CODEX_IDLE_ABORT_SEC}s_`
  );
}

/**
 * Compact list of sessions NOT in the current thread, so thread-scoped
 * `/status` still surfaces hung sessions elsewhere. Caller is responsible
 * for the 1024-char Discord embed-field limit.
 */
function renderOtherSessionsFooter(deps: {
  threadId: string;
  channelManager: import('../channel-manager.js').ChannelManager;
  codexSessionManager?: import('../codex/codex-session-manager.js').CodexSessionManager;
  claudeSdkSessionManager?: import('../claude-sdk/claude-sdk-session-manager.js').ClaudeSdkSessionManager;
  agentSessionManager?: import('../agents/agent-session-manager.js').AgentSessionManager;
}): string | null {
  const { threadId, channelManager, codexSessionManager, claudeSdkSessionManager, agentSessionManager } = deps;
  const lines: string[] = [];

  const ptyOther = channelManager.getAllActive().filter(m => m.threadId !== threadId);
  for (const m of ptyOther) {
    lines.push(`PTY \`${m.sessionId.slice(0, 8)}\` ${m.status} · <#${m.threadId}>`);
  }
  const sdkOther = (claudeSdkSessionManager?.getAllSessions() ?? [])
    .filter(s => s.status !== 'ended' && s.discordThreadId !== threadId);
  for (const s of sdkOther) {
    lines.push(`SDK \`${s.id.slice(0, 8)}\` ${s.status} · <#${s.discordThreadId}>`);
  }
  const codexOther = (codexSessionManager?.getAllSessions() ?? [])
    .filter(s => s.status !== 'ended' && s.discordThreadId !== threadId);
  for (const s of codexOther) {
    const marker = codexHangMarker(s);
    lines.push(`Codex \`${s.id.slice(0, 8)}\` ${s.status}${marker} · <#${s.discordThreadId}>`);
  }
  const agentOther = (agentSessionManager?.getAllSessions() ?? [])
    .filter(s => s.status !== 'ended' && s.discordThreadId !== threadId);
  for (const s of agentOther) {
    lines.push(`${s.modelAlias} \`${s.id.slice(0, 8)}\` ${s.status} · <#${s.discordThreadId}>`);
  }

  if (lines.length === 0) return null;
  // Cap line count so embed field never overflows on a busy day.
  const capped = lines.length > 12 ? [...lines.slice(0, 12), `…and ${lines.length - 12} more`] : lines;
  return capped.join('\n');
}

function fmtUptimeShort(uptimeSec: number): string {
  if (uptimeSec < 60) return `${Math.floor(uptimeSec)}s`;
  const min = Math.floor(uptimeSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d${hr % 24}h`;
}
