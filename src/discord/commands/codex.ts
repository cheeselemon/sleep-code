/**
 * /codex command handler with subcommands:
 * start, stop, status
 */

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
} from 'discord.js';
import { basename } from 'path';
import type { CommandHandler } from './types.js';

export const handleCodex: CommandHandler = async (interaction, context) => {
  const { codexSessionManager, settingsManager } = context;
  const subcommand = interaction.options.getSubcommand();

  if (!codexSessionManager) {
    await interaction.reply({
      content: '⚠️ Codex is not enabled. Set `OPENAI_API_KEY` to enable.',
      ephemeral: true,
    });
    return;
  }

  // /codex start - show directory selection
  if (subcommand === 'start') {
    if (!settingsManager) {
      await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
      return;
    }

    const dirs = settingsManager.getAllowedDirectories();
    if (dirs.length === 0) {
      await interaction.reply({
        content: '⚠️ No directories configured. Use `/claude add-dir` first.',
        ephemeral: true,
      });
      return;
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('codex_start_dir')
      .setPlaceholder('Select a directory...');

    for (const dir of dirs.slice(0, 25)) {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(basename(dir))
          .setDescription(dir.slice(0, 100))
          .setValue(dir)
      );
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.reply({
      content: '📁 **Start Codex Session**\nSelect a directory:',
      components: [row],
      ephemeral: true,
    });
    return;
  }

  // /codex stop - show session selection
  if (subcommand === 'stop') {
    const sessions = codexSessionManager.getAllSessions().filter(s => s.status !== 'ended');
    if (sessions.length === 0) {
      await interaction.reply({ content: '✅ No running Codex sessions to stop.', ephemeral: true });
      return;
    }

    const currentCodexSession = codexSessionManager.getSessionByDiscordThread(interaction.channelId);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('codex_stop_session')
      .setPlaceholder('Select a Codex session to stop...');

    for (const entry of sessions.slice(0, 25)) {
      const isCurrent = entry.id === currentCodexSession?.id;
      const label = isCurrent
        ? `⭐ ${basename(entry.cwd)} (current)`
        : `${basename(entry.cwd)} (${entry.id.slice(0, 8)})`;
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(label.slice(0, 100))
          .setDescription(`Status: ${entry.status}`)
          .setValue(entry.id)
      );
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.reply({
      content: '🛑 **Stop Codex Session**\nSelect a session:',
      components: [row],
      ephemeral: true,
    });
    return;
  }

  // /codex status - show all Codex sessions
  if (subcommand === 'status') {
    const sessions = codexSessionManager.getAllSessions();
    if (sessions.length === 0) {
      await interaction.reply({ content: '📋 No Codex sessions.', ephemeral: true });
      return;
    }

    const statusEmoji: Record<string, string> = {
      starting: '🔄',
      running: '🟢',
      idle: '🟡',
      ended: '⚫',
    };

    const lines = sessions.map(e => {
      const emoji = statusEmoji[e.status] || '❓';
      const age = Math.floor((Date.now() - e.startedAt.getTime()) / 60000);
      return `${emoji} **${basename(e.cwd)}** (${e.id.slice(0, 8)})\n   Status: ${e.status} | Age: ${age}m`;
    });

    const embed = new EmbedBuilder()
      .setTitle('📊 Codex Sessions')
      .setDescription(lines.join('\n\n'))
      .setColor(0x10A37F)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }
};
