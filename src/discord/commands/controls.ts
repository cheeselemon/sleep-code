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

  const sent = context.sessionManager.sendInput(result.sessionId, '\x02', false); // Ctrl+B
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

  const parts: string[] = [];

  // Interrupt Claude (Escape x2)
  const sent = context.sessionManager.sendInput(result.sessionId, '\x1b\x1b', false);
  parts.push(sent ? '🛑 Claude interrupted' : '⚠️ Claude: session not connected');

  // Also interrupt Codex if active in the same thread
  if (context.codexSessionManager) {
    const codexSession = context.codexSessionManager.getSessionByDiscordThread(interaction.channelId);
    if (codexSession) {
      const codexInterrupted = context.codexSessionManager.interruptSession(codexSession.id);
      if (codexInterrupted) {
        parts.push('🛑 Codex interrupted');
      }
    }
  }

  await interaction.reply(parts.join('\n'));
};

export const handleMode: CommandHandler = async (interaction, context) => {
  const result = getSessionFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  const sent = context.sessionManager.sendInput(result.sessionId, '\x1b[Z', false); // Shift+Tab
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
