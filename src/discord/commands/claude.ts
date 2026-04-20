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
  const { channelManager, claudeSdkSessionManager, processManager, settingsManager } = context;
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

  // /claude start-sdk - show model/context selection first, then directory
  if (subcommand === 'start-sdk') {
    if (!claudeSdkSessionManager || !settingsManager) {
      await interaction.reply({
        content: '⚠️ Claude SDK is not enabled.',
        ephemeral: true,
      });
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

    // Model + context window selection
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('claude_sdk_start_config')
      .setPlaceholder('Select model & context window...');

    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Opus 4.7 (200K)')
        .setDescription('claude-opus-4-7 · Latest · 128k output')
        .setValue('claude-opus-4-7:200k'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Opus 4.7 (1M)')
        .setDescription('claude-opus-4-7 · Latest · 1M extended context')
        .setValue('claude-opus-4-7:1m'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Opus 4.6 (200K)')
        .setDescription('claude-opus-4-6 · 128k output')
        .setValue('claude-opus-4-6:200k'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Opus 4.6 (1M)')
        .setDescription('claude-opus-4-6 · 1M extended context')
        .setValue('claude-opus-4-6:1m'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Sonnet 4.6 (200K)')
        .setDescription('claude-sonnet-4-6 · Fast · 64k output')
        .setValue('claude-sonnet-4-6:200k'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Sonnet 4.6 (1M)')
        .setDescription('claude-sonnet-4-6 · Fast · 1M extended context')
        .setValue('claude-sonnet-4-6:1m'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Haiku 4.5 (200K)')
        .setDescription('claude-haiku-4-5 · Fastest · 64k output')
        .setValue('claude-haiku-4-5:200k'),
    );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.reply({
      content: '📡 **Start Claude SDK Session**\nSelect model & context window:',
      components: [row],
      ephemeral: true,
    });
    return;
  }

  // /claude stop - show session selection (PTY + SDK)
  if (subcommand === 'stop') {
    // Collect all stoppable sessions
    interface StoppableSession {
      id: string;
      cwd: string;
      type: 'pty' | 'sdk';
      label: string;
      description: string;
    }
    const sessions: StoppableSession[] = [];

    // PTY sessions
    if (processManager) {
      const running = await processManager.getAllRunning();
      for (const e of running) {
        sessions.push({
          id: e.sessionId,
          cwd: e.cwd,
          type: 'pty',
          label: `🔧 ${basename(e.cwd)}`,
          description: `PTY | PID ${e.pid} | ${e.status}`,
        });
      }
    }

    // SDK sessions
    if (claudeSdkSessionManager) {
      for (const s of claudeSdkSessionManager.getAllSessions()) {
        if (s.status !== 'ended') {
          sessions.push({
            id: s.id,
            cwd: s.cwd,
            type: 'sdk',
            label: `📡 ${basename(s.cwd)}`,
            description: `SDK | ${s.status}`,
          });
        }
      }
    }

    if (sessions.length === 0) {
      await interaction.reply({ content: '✅ No running sessions to stop.', ephemeral: true });
      return;
    }

    // Check both PTY and SDK sessions for current thread highlight
    const currentSessionId = channelManager.getSessionByChannel(interaction.channelId)
      || channelManager.getSdkSessionByThread(interaction.channelId);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('claude_stop_session')
      .setPlaceholder('Select a session to stop...');

    // Sort: current session first
    const sorted = [...sessions].sort((a, b) => {
      if (a.id === currentSessionId) return -1;
      if (b.id === currentSessionId) return 1;
      return 0;
    });

    for (const entry of sorted.slice(0, 25)) {
      const isCurrent = entry.id === currentSessionId;
      const label = isCurrent
        ? `⭐ ${entry.label} (current)`
        : `${entry.label} (${entry.id.slice(0, 8)})`;
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(label.slice(0, 100))
          .setDescription(entry.description)
          .setValue(`${entry.type}:${entry.id}`)
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

  // /claude status - show all sessions (PTY + SDK)
  if (subcommand === 'status') {
    const lines: string[] = [];

    const statusEmoji: Record<string, string> = {
      starting: '🔄',
      running: '🟢',
      stopping: '🟡',
      stopped: '⚫',
      orphaned: '🔴',
      idle: '💤',
      ended: '⚫',
      needs_restore: '🔄',
    };

    // PTY sessions
    if (processManager) {
      for (const e of processManager.getAllEntries()) {
        const emoji = statusEmoji[e.status] || '❓';
        const age = Math.floor((Date.now() - new Date(e.startedAt).getTime()) / 60000);
        lines.push(`${emoji} 🔧 **${basename(e.cwd)}** (${e.sessionId.slice(0, 8)})\n   PTY | PID: ${e.pid} | ${e.status} | ${age}m`);
      }
    }

    // SDK sessions
    if (claudeSdkSessionManager) {
      for (const s of claudeSdkSessionManager.getAllSessions()) {
        const emoji = statusEmoji[s.status] || '❓';
        const age = Math.floor((Date.now() - s.startedAt.getTime()) / 60000);
        lines.push(`${emoji} 📡 **${basename(s.cwd)}** (${s.id.slice(0, 8)})\n   SDK | ${s.status} | ${age}m`);
      }
    }

    if (lines.length === 0) {
      await interaction.reply({ content: '📋 No managed sessions.', ephemeral: true });
      return;
    }

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

  // /claude restore - restore a dead session in this thread
  if (subcommand === 'restore') {
    if (!processManager || !settingsManager) {
      await interaction.reply({ content: '⚠️ Process management not enabled.', flags: 64 });
      return;
    }

    const threadId = interaction.channelId;

    // Find persisted mapping for this thread
    const allPersisted = channelManager.getAllPersisted();
    const mapping = allPersisted.find(m => m.threadId === threadId);

    if (!mapping) {
      await interaction.reply({
        content: '❌ No previous session found for this thread.',
        flags: 64,
      });
      return;
    }

    // Check if there's already a live session in this thread
    const liveSession = channelManager.getSessionByChannel(threadId);
    if (liveSession) {
      await interaction.reply({
        content: '⚠️ A session is already running in this thread.',
        flags: 64,
      });
      return;
    }

    await interaction.reply({
      content:
        `🔄 **Restoring session...**\n` +
        `Directory: \`${mapping.cwd}\`\n` +
        `Session: \`${mapping.sessionId.slice(0, 8)}...\``,
    });

    try {
      const terminalApp = settingsManager.getTerminalApp();
      await processManager.spawn(mapping.cwd, mapping.sessionId, terminalApp, true);

      await interaction.editReply({
        content:
          `✅ **Session restoring**\n` +
          `Directory: \`${mapping.cwd}\`\n` +
          `Waiting for Claude to connect...`,
      });
    } catch (err) {
      await interaction.editReply({
        content: `❌ **Failed to restore**: ${(err as Error).message}`,
      });
    }
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
