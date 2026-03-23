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
          '`/claude start` - Start a PTY session (terminal)',
          '`/claude start-sdk` - Start an SDK session (lightweight)',
          '`/claude stop` - Stop a running session',
          '`/claude restore` - Restore a dead session in this thread',
          '`/claude status` - Show all managed sessions',
          '`/sessions` - List active sessions',
          '`/status` - Show current thread session status',
        ].join('\n'),
      },
      {
        name: '🎮 In-Session Controls',
        value: [
          '`/interrupt` - Interrupt current turn (session stays alive)',
          '`/yolo-sleep` - Toggle auto-approve mode',
          '`/panel` - Show control panel with buttons',
          '`/model <name>` - Switch model (opus/sonnet/haiku)',
          '`/compact` - Compact the conversation (PTY only)',
          '`/background` - Send to background (PTY only)',
          '`/mode` - Toggle plan/execute mode (PTY only)',
        ].join('\n'),
      },
      {
        name: '🟢 Codex (OpenAI)',
        value: [
          '`/codex start` - Start a new Codex session',
          '`/codex stop` - Stop a running Codex session',
          '`/codex status` - Show all Codex sessions',
          '`x:` or `codex:` prefix → route to Codex',
          '`c:` or `claude:` prefix → route to Claude',
        ].join('\n'),
      },
      {
        name: '⚙️ Settings',
        value: [
          '`/claude add-dir <path>` - Add directory to whitelist',
          '`/claude remove-dir` - Remove directory from whitelist',
          '`/claude list-dirs` - List whitelisted directories',
          '`/claude set-terminal` - Set terminal app',
          '`/commands` - List all slash commands',
        ].join('\n'),
      },
      {
        name: '💡 Tips',
        value: [
          'SDK sessions auto-resume after bot restart (lazy resume)',
          'Context usage shown after each SDK turn (🟢🟡🔴)',
          'Attach `.txt` files to inject content into session',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'Use commands in a session thread for in-session controls' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
};
