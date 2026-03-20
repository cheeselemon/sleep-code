/**
 * In-session control commands: /interrupt, /background, /mode, /compact, /model
 */

import type { CommandHandler } from './types.js';
import { getTransportFromChannel } from './helpers.js';

function getUnsupportedTransportMessage(commandName: string): string {
  return `⚠️ \`/${commandName}\` is not supported in SDK sessions.`;
}

export const handleBackground: CommandHandler = async (interaction, context) => {
  const result = getTransportFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  if (!result.transport.supportsTerminalControls) {
    await interaction.reply(getUnsupportedTransportMessage('background'));
    return;
  }

  const sent = await Promise.resolve(result.transport.sendInput('\x02', { submit: false })); // Ctrl+B
  if (sent) {
    await interaction.reply('⬇️ Sent background command (Ctrl+B)');
  } else {
    await interaction.reply('⚠️ Failed to send command - session not connected.');
  }
};

export const handleInterrupt: CommandHandler = async (interaction, context) => {
  const result = getTransportFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  const parts: string[] = [];

  const sent = await Promise.resolve(result.transport.interrupt());
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
  const result = getTransportFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  if (!result.transport.supportsTerminalControls) {
    await interaction.reply(getUnsupportedTransportMessage('mode'));
    return;
  }

  const sent = await Promise.resolve(result.transport.sendInput('\x1b[Z', { submit: false })); // Shift+Tab
  if (sent) {
    await interaction.reply('🔄 Sent mode toggle (Shift+Tab)');
  } else {
    await interaction.reply('⚠️ Failed to send command - session not connected.');
  }
};

export const handleCompact: CommandHandler = async (interaction, context) => {
  const result = getTransportFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  if (!result.transport.supportsTerminalControls) {
    await interaction.reply(getUnsupportedTransportMessage('compact'));
    return;
  }

  const sent = await Promise.resolve(result.transport.sendInput('/compact\n'));
  if (sent) {
    await interaction.reply('🗜️ Sent /compact');
  } else {
    await interaction.reply('⚠️ Failed to send command - session not connected.');
  }
};

export const handleModel: CommandHandler = async (interaction, context) => {
  const result = getTransportFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  if (!result.transport.supportsModelSwitch) {
    await interaction.reply(getUnsupportedTransportMessage('model'));
    return;
  }

  const modelArg = interaction.options.getString('name', true);
  const command = `/model ${modelArg}`;
  // Don't add \n - sendInput will add \r after 100ms
  const sent = await Promise.resolve(result.transport.sendInput(command));
  if (sent) {
    await interaction.reply(`🧠 Sent ${command}`);
  } else {
    await interaction.reply('⚠️ Failed to send command - session not connected.');
  }
};
