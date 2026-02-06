/**
 * In-session control commands: /interrupt, /background, /mode, /compact, /model
 */

import type { CommandHandler } from './types.js';

/**
 * Helper to validate session context
 */
function getSessionFromChannel(
  channelId: string,
  context: Parameters<CommandHandler>[1]
): { sessionId: string } | { error: string } {
  const { channelManager } = context;

  const sessionId = channelManager.getSessionByChannel(channelId);
  if (!sessionId) {
    return { error: 'This channel is not associated with an active session.' };
  }

  const channel = channelManager.getChannel(sessionId);
  if (!channel || channel.status === 'ended') {
    return { error: 'This session has ended.' };
  }

  return { sessionId };
}

export const handleBackground: CommandHandler = async (interaction, context) => {
  const result = getSessionFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  const sent = context.sessionManager.sendInput(result.sessionId, '\x02'); // Ctrl+B
  if (sent) {
    await interaction.reply('⬇️ Sent background command (Ctrl+B)');
  } else {
    await interaction.reply('⚠️ Failed to send command - session not connected.');
  }
};

export const handleInterrupt: CommandHandler = async (interaction, context) => {
  const result = getSessionFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  const sent = context.sessionManager.sendInput(result.sessionId, '\x1b'); // Escape
  if (sent) {
    await interaction.reply('🛑 Sent interrupt (Escape)');
  } else {
    await interaction.reply('⚠️ Failed to send command - session not connected.');
  }
};

export const handleMode: CommandHandler = async (interaction, context) => {
  const result = getSessionFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  const sent = context.sessionManager.sendInput(result.sessionId, '\x1b[Z'); // Shift+Tab
  if (sent) {
    await interaction.reply('🔄 Sent mode toggle (Shift+Tab)');
  } else {
    await interaction.reply('⚠️ Failed to send command - session not connected.');
  }
};

export const handleCompact: CommandHandler = async (interaction, context) => {
  const result = getSessionFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  const sent = context.sessionManager.sendInput(result.sessionId, '/compact\n');
  if (sent) {
    await interaction.reply('🗜️ Sent /compact');
  } else {
    await interaction.reply('⚠️ Failed to send command - session not connected.');
  }
};

export const handleModel: CommandHandler = async (interaction, context) => {
  const result = getSessionFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  const modelArg = interaction.options.getString('name', true);
  const command = `/model ${modelArg}`;
  // Don't add \n - sendInput will add \r after 100ms
  const sent = context.sessionManager.sendInput(result.sessionId, command);
  if (sent) {
    await interaction.reply(`🧠 Sent ${command}`);
  } else {
    await interaction.reply('⚠️ Failed to send command - session not connected.');
  }
};
