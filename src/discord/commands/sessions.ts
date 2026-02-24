/**
 * /sessions command handler
 */

import { formatSessionStatus } from '../../slack/message-formatter.js';
import type { CommandHandler } from './types.js';

export const handleSessions: CommandHandler = async (interaction, context) => {
  const { channelManager, codexSessionManager } = context;

  const claudeActive = channelManager.getAllActive();
  const codexSessions = codexSessionManager?.getAllSessions().filter(s => s.status !== 'ended') ?? [];

  if (claudeActive.length === 0 && codexSessions.length === 0) {
    await interaction.reply('No active sessions. Start a session with `/claude start` or `/codex start`');
    return;
  }

  const lines: string[] = [];

  if (claudeActive.length > 0) {
    lines.push('**Claude Sessions:**');
    for (const s of claudeActive) {
      lines.push(`  <#${s.threadId}> (in <#${s.channelId}>) - ${formatSessionStatus(s.status)}`);
    }
  }

  if (codexSessions.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('**Codex Sessions:**');
    for (const s of codexSessions) {
      lines.push(`  <#${s.discordThreadId}> - ${s.status}`);
    }
  }

  await interaction.reply(lines.join('\n'));
};
