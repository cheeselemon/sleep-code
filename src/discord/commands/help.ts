/**
 * /help command handler
 */

import { EmbedBuilder } from 'discord.js';
import type { CommandHandler } from './types.js';

export const handleHelp: CommandHandler = async (interaction) => {
  const embed = new EmbedBuilder()
    .setTitle('🤖 Sleep Code Commands')
    .setDescription('Monitor and control Claude Code sessions from Discord')
    .setColor(0x7289DA)
    .addFields(
      {
        name: '📁 Session Management',
        value: [
          '`/claude start` - Start a new Claude session',
          '`/claude stop` - Stop a running session',
          '`/claude status` - Show all managed sessions',
          '`/sessions` - List active sessions',
        ].join('\n'),
      },
      {
        name: '🎮 In-Session Controls',
        value: [
          '`/interrupt` - Interrupt Claude (Escape)',
          '`/background` - Send to background (Ctrl+B)',
          '`/mode` - Toggle plan/execute mode (Shift+Tab)',
          '`/compact` - Compact the conversation',
          '`/model <name>` - Switch model (opus/sonnet/haiku)',
          '`/panel` - Show control panel with buttons',
          '`/yolo-sleep` - Toggle auto-approve mode',
        ].join('\n'),
      },
      {
        name: '⚙️ Settings',
        value: [
          '`/claude add-dir <path>` - Add directory to whitelist',
          '`/claude remove-dir` - Remove directory from whitelist',
          '`/claude list-dirs` - List whitelisted directories',
          '`/claude set-terminal` - Set terminal app',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'Use commands in a session thread for in-session controls' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
};
