/**
 * /claude command handler with subcommands:
 * start, stop, status, add-dir, remove-dir, list-dirs, set-terminal
 */

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
} from 'discord.js';
import { basename } from 'path';
import { getInstalledTerminals } from '../utils.js';
import type { CommandHandler } from './types.js';

export const handleClaude: CommandHandler = async (interaction, context) => {
  const { channelManager, processManager, settingsManager } = context;
  const subcommand = interaction.options.getSubcommand();

  // /claude start - show directory selection
  if (subcommand === 'start') {
    if (!processManager || !settingsManager) {
      await interaction.reply({ content: '⚠️ Process management not enabled.', ephemeral: true });
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

    // Create select menu for directories
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('claude_start_dir')
      .setPlaceholder('Select a directory...');

    for (const dir of dirs.slice(0, 25)) { // Discord limit: 25 options
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(basename(dir))
          .setDescription(dir.slice(0, 100))
          .setValue(dir)
      );
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.reply({
      content: '📁 **Start Claude Session**\nSelect a directory:',
      components: [row],
      ephemeral: true,
    });
    return;
  }

  // /claude stop - show session selection
  if (subcommand === 'stop') {
    if (!processManager) {
      await interaction.reply({ content: '⚠️ Process management not enabled.', ephemeral: true });
      return;
    }

    const running = await processManager.getAllRunning();
    if (running.length === 0) {
      await interaction.reply({ content: '✅ No running sessions to stop.', ephemeral: true });
      return;
    }

    // Get current session if command is run from a session thread
    const currentSessionId = channelManager.getSessionByChannel(interaction.channelId);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('claude_stop_session')
      .setPlaceholder('Select a session to stop...');

    for (const entry of running.slice(0, 25)) {
      const isCurrent = entry.sessionId === currentSessionId;
      const label = isCurrent
        ? `⭐ ${basename(entry.cwd)} (current)`
        : `${basename(entry.cwd)} (${entry.sessionId.slice(0, 8)})`;
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(label.slice(0, 100))
          .setDescription(`PID ${entry.pid} - ${entry.status}`)
          .setValue(entry.sessionId)
      );
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.reply({
      content: '🛑 **Stop Claude Session**\nSelect a session:',
      components: [row],
      ephemeral: true,
    });
    return;
  }

  // /claude status - show all sessions
  if (subcommand === 'status') {
    if (!processManager) {
      await interaction.reply({ content: '⚠️ Process management not enabled.', ephemeral: true });
      return;
    }

    const entries = processManager.getAllEntries();
    if (entries.length === 0) {
      await interaction.reply({ content: '📋 No managed sessions.', ephemeral: true });
      return;
    }

    const statusEmoji: Record<string, string> = {
      starting: '🔄',
      running: '🟢',
      stopping: '🟡',
      stopped: '⚫',
      orphaned: '🔴',
    };

    const lines = entries.map(e => {
      const emoji = statusEmoji[e.status] || '❓';
      const age = Math.floor((Date.now() - new Date(e.startedAt).getTime()) / 60000);
      return `${emoji} **${basename(e.cwd)}** (${e.sessionId.slice(0, 8)})\n   PID: ${e.pid} | Status: ${e.status} | Age: ${age}m`;
    });

    const embed = new EmbedBuilder()
      .setTitle('📊 Claude Sessions')
      .setDescription(lines.join('\n\n'))
      .setColor(0x7289DA)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  // /claude add-dir - add directory to whitelist
  if (subcommand === 'add-dir') {
    if (!settingsManager) {
      await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
      return;
    }

    const path = interaction.options.getString('path', true);
    const result = await settingsManager.addDirectory(path);

    if (result.success) {
      await interaction.reply({ content: `✅ Added \`${path}\` to whitelist.`, ephemeral: true });
    } else {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
    }
    return;
  }

  // /claude remove-dir - show directory selection for removal
  if (subcommand === 'remove-dir') {
    if (!settingsManager) {
      await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
      return;
    }

    const dirs = settingsManager.getAllowedDirectories();
    if (dirs.length === 0) {
      await interaction.reply({ content: '📁 No directories in whitelist.', ephemeral: true });
      return;
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('claude_remove_dir')
      .setPlaceholder('Select a directory to remove...');

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
      content: '🗑️ **Remove Directory**\nSelect a directory to remove:',
      components: [row],
      ephemeral: true,
    });
    return;
  }

  // /claude list-dirs - list whitelisted directories
  if (subcommand === 'list-dirs') {
    if (!settingsManager) {
      await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
      return;
    }

    const dirs = settingsManager.getAllowedDirectories();
    if (dirs.length === 0) {
      await interaction.reply({
        content: '📁 **Whitelisted Directories**\nNo directories configured. Use `/claude add-dir` to add one.',
        ephemeral: true,
      });
      return;
    }

    const defaultDir = settingsManager.getDefaultDirectory();
    const lines = dirs.map(d => {
      const isDefault = d === defaultDir;
      return `• \`${d}\`${isDefault ? ' ⭐ (default)' : ''}`;
    });

    await interaction.reply({
      content: `📁 **Whitelisted Directories**\n${lines.join('\n')}`,
      ephemeral: true,
    });
    return;
  }

  // /claude set-terminal - set terminal app for new sessions
  if (subcommand === 'set-terminal') {
    if (!settingsManager) {
      await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
      return;
    }

    const installed = getInstalledTerminals();
    const currentApp = settingsManager.getTerminalApp();

    const currentLabel: Record<string, string> = {
      terminal: 'Terminal.app',
      iterm2: 'iTerm2',
      background: 'Background',
    };

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('claude_set_terminal')
      .setPlaceholder('Select terminal app...');

    // Always add background option
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Background (no window)')
        .setDescription('Run in background without terminal window')
        .setValue('background')
        .setDefault(currentApp === 'background')
    );

    // Add Terminal.app if installed
    if (installed.terminal) {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Terminal.app')
          .setDescription('macOS default terminal')
          .setValue('terminal')
          .setDefault(currentApp === 'terminal')
      );
    }

    // Add iTerm2 if installed
    if (installed.iterm2) {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('iTerm2')
          .setDescription('Popular third-party terminal')
          .setValue('iterm2')
          .setDefault(currentApp === 'iterm2')
      );
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.reply({
      content: `🖥️ **Terminal Settings**\nCurrent: **${currentLabel[currentApp]}**\n\nSelect where to open new sessions:`,
      components: [row],
      ephemeral: true,
    });
    return;
  }
};
