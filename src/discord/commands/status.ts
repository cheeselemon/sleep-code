/**
 * /status command handler
 * Shows current thread's session status (Claude, Codex, YOLO, routing)
 */

import { EmbedBuilder } from 'discord.js';
import { basename } from 'path';
import { MAX_AGENT_ROUTING } from '../state.js';
import type { CommandHandler } from './types.js';

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
  const { channelManager, sessionManager, processManager, codexSessionManager, state } = context;

  // Thread check
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: '이 명령은 세션 스레드에서만 사용할 수 있습니다.', ephemeral: true });
    return;
  }

  const threadId = interaction.channelId;
  const agents = channelManager.getAgentsInThread(threadId);

  if (!agents.claude && !agents.codex) {
    await interaction.reply({ content: '이 스레드에 활성 세션이 없습니다.', ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('📊 Thread Status')
    .setColor(0x00AE86);

  const lines: string[] = [];

  // Claude info
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

    lines.push(`**Claude** ${emoji} ${processStatus}`);
    lines.push(`  Session: \`${agents.claude.slice(0, 8)}\``);
    lines.push(`  PID: \`${pid}\`  Socket: ${socket}`);
    lines.push(`  Directory: \`${cwd}\``);
    lines.push('');
  }

  // Codex info
  if (agents.codex && codexSessionManager) {
    const codexSession = codexSessionManager.getSession(agents.codex);
    const status = codexSession?.status ?? 'unknown';
    const emoji = STATUS_EMOJI[status] ?? '❓';
    const sandbox = codexSession?.sandboxMode ?? '—';

    lines.push(`**Codex** ${emoji} ${status}`);
    lines.push(`  Session: \`${agents.codex.slice(0, 8)}\``);
    lines.push(`  Sandbox: \`${sandbox}\``);
    lines.push('');
  }

  // Common state
  const yolo = agents.claude && state.yoloSessions.has(agents.claude);
  const lastActive = state.lastActiveAgent.get(threadId) ?? '—';
  const routingCount = state.agentRoutingCount.get(threadId) ?? 0;

  lines.push(`YOLO: ${yolo ? '🔥 ON' : '🛡️ OFF'}`);
  lines.push(`Last active: **${lastActive}**`);
  lines.push(`Routing: \`${routingCount}/${MAX_AGENT_ROUTING}\``);

  embed.setDescription(lines.join('\n'));

  await interaction.reply({ embeds: [embed], ephemeral: true });
};
