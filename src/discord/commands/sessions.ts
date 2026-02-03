/**
 * /sessions command handler
 */

import { formatSessionStatus } from '../../slack/message-formatter.js';
import type { CommandHandler } from './types.js';

export const handleSessions: CommandHandler = async (interaction, context) => {
  const { channelManager } = context;

  const active = channelManager.getAllActive();
  if (active.length === 0) {
    await interaction.reply('No active sessions. Start a session with `sleep-code run -- claude`');
    return;
  }

  const text = active
    .map((s) => `<#${s.threadId}> (in <#${s.channelId}>) - ${formatSessionStatus(s.status)}`)
    .join('\n');

  await interaction.reply(`**Active Sessions:**\n${text}`);
};
