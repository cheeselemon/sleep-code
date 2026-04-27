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

  // /codex start - show model + reasoning effort selection first, then directory
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

    // Step 1: model + reasoning effort.
    // Value format: `<model-slug>:<effort>` decoded by handleCodexStartConfigSelect.
    // Models sourced from ~/.codex/models_cache.json (visibility: list).
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('codex_start_config')
      .setPlaceholder('Select model & reasoning effort...');

    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('GPT-5.5 (high)')
        .setDescription('Frontier · strong reasoning · default')
        .setValue('gpt-5.5:high'),
      new StringSelectMenuOptionBuilder()
        .setLabel('GPT-5.5 (xhigh)')
        .setDescription('Frontier · deepest reasoning · slowest')
        .setValue('gpt-5.5:xhigh'),
      new StringSelectMenuOptionBuilder()
        .setLabel('GPT-5.5 (medium)')
        .setDescription('Frontier · balanced')
        .setValue('gpt-5.5:medium'),
      new StringSelectMenuOptionBuilder()
        .setLabel('GPT-5.5 (low)')
        .setDescription('Frontier · fastest')
        .setValue('gpt-5.5:low'),
      new StringSelectMenuOptionBuilder()
        .setLabel('GPT-5.4 (high)')
        .setDescription('Previous gen · strong reasoning')
        .setValue('gpt-5.4:high'),
      new StringSelectMenuOptionBuilder()
        .setLabel('GPT-5.4 (medium)')
        .setDescription('Previous gen · balanced')
        .setValue('gpt-5.4:medium'),
      new StringSelectMenuOptionBuilder()
        .setLabel('GPT-5.4-mini (medium)')
        .setDescription('Smaller · faster · cheaper')
        .setValue('gpt-5.4-mini:medium'),
      new StringSelectMenuOptionBuilder()
        .setLabel('GPT-5.3-codex (high)')
        .setDescription('Coding-specialized · strong reasoning')
        .setValue('gpt-5.3-codex:high'),
      new StringSelectMenuOptionBuilder()
        .setLabel('GPT-5.2 (medium)')
        .setDescription('Legacy · balanced')
        .setValue('gpt-5.2:medium'),
    );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.reply({
      content: '🤖 **Start Codex Session**\nSelect model & reasoning effort:',
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

  // /codex intelligence - change reasoning effort of session in this thread
  if (subcommand === 'intelligence') {
    const session = codexSessionManager.getSessionByDiscordThread(interaction.channelId);
    if (!session) {
      await interaction.reply({
        content: '⚠️ No Codex session in this thread. Start one with `/codex start`.',
        ephemeral: true,
      });
      return;
    }

    if (session.status === 'ended') {
      await interaction.reply({
        content: '⚠️ This Codex session has ended.',
        ephemeral: true,
      });
      return;
    }

    // Effort picker — current effort is marked as default in the menu
    // so the user can see what's currently active without leaving the picker.
    const effortOptions: Array<{ value: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; label: string; description: string }> = [
      { value: 'xhigh', label: 'xhigh', description: 'Extra high · deepest reasoning · slowest' },
      { value: 'high', label: 'high', description: 'Strong reasoning · slower' },
      { value: 'medium', label: 'medium', description: 'Balanced · default' },
      { value: 'low', label: 'low', description: 'Light reasoning · faster' },
      { value: 'minimal', label: 'minimal', description: 'Almost no reasoning · fastest' },
    ];

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`codex_intelligence:${session.id}`)
      .setPlaceholder(`Current: ${session.modelReasoningEffort} — pick a new level...`);

    for (const opt of effortOptions) {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(opt.label)
          .setDescription(opt.description)
          .setValue(opt.value)
          .setDefault(session.modelReasoningEffort === opt.value)
      );
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.reply({
      content: `🧠 **Change Codex Reasoning Effort**\nModel: \`${session.model}\` · Current: **${session.modelReasoningEffort}**\n\n⚠️ Switching aborts the current turn and resumes the thread with new effort.`,
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
