/**
 * /chat command handler with subcommands:
 * start, stop, status, models
 */

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
} from 'discord.js';
import { basename } from 'path';
import type { CommandHandler } from './types.js';
import { MODEL_REGISTRY } from '../agents/model-registry.js';
import type { AgentSessionManager } from '../agents/agent-session-manager.js';

export const handleChat: CommandHandler = async (interaction, context) => {
  const agentSessionManager = (context as any).agentSessionManager as AgentSessionManager | undefined;
  const { settingsManager } = context;
  const subcommand = interaction.options.getSubcommand();

  if (!agentSessionManager) {
    await interaction.reply({
      content: '⚠️ Agent system is not enabled. Set `OPENROUTER_API_KEY` or `DEEPINFRA_API_KEY` to enable.',
      ephemeral: true,
    });
    return;
  }

  // /chat start - select model then directory
  if (subcommand === 'start') {
    const modelArg = interaction.options.getString('model');

    if (!modelArg) {
      // Show model selection
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('chat_start_model')
        .setPlaceholder('Select a model...');

      for (const model of MODEL_REGISTRY) {
        const priceStr = model.pricing.inputPerMTok === 0
          ? 'Free'
          : `$${model.pricing.inputPerMTok}/$${model.pricing.outputPerMTok} per 1M`;
        selectMenu.addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel(model.displayName)
            .setDescription(`${model.alias} · ${(model.contextWindow / 1024).toFixed(0)}K ctx · ${priceStr}`)
            .setValue(model.alias)
        );
      }

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

      await interaction.reply({
        content: '🤖 **Start Agent Session**\nSelect a model:',
        components: [row],
        ephemeral: true,
      });
      return;
    }

    // Model specified, show directory selection
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
      .setCustomId(`chat_start_dir:${modelArg}`)
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
      content: `🤖 **Start ${modelArg} Session**\nSelect a directory:`,
      components: [row],
      ephemeral: true,
    });
    return;
  }

  // /chat stop - stop current thread's agent session
  if (subcommand === 'stop') {
    const sessions = agentSessionManager.getAllSessions().filter(s =>
      s.status !== 'ended' && s.discordThreadId === interaction.channelId
    );

    if (sessions.length === 0) {
      await interaction.reply({ content: '✅ No running agent sessions in this thread.', ephemeral: true });
      return;
    }

    for (const session of sessions) {
      await agentSessionManager.stopSession(session.id);
    }

    await interaction.reply({
      content: `🛑 Stopped ${sessions.length} agent session(s).`,
    });
    return;
  }

  // /chat status - show all active agent sessions
  if (subcommand === 'status') {
    const sessions = agentSessionManager.getAllSessions().filter(s => s.status !== 'ended');

    if (sessions.length === 0) {
      await interaction.reply({ content: '📭 No active agent sessions.', ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🤖 Active Agent Sessions')
      .setColor(0x00cc88);

    for (const session of sessions) {
      const uptime = Math.round((Date.now() - session.startedAt.getTime()) / 60_000);
      embed.addFields({
        name: `${session.modelDef.displayName} (${session.modelAlias})`,
        value: [
          `📁 \`${basename(session.cwd)}\``,
          `🔄 Status: ${session.status}`,
          `💬 Turns: ${session.turnCount}`,
          `💰 Cost: $${session.totalCostUSD.toFixed(4)}`,
          `⏱️ Uptime: ${uptime}m`,
        ].join('\n'),
        inline: true,
      });
    }

    await interaction.reply({ embeds: [embed] });
    return;
  }

  // /chat models - show available models
  if (subcommand === 'models') {
    const embed = new EmbedBuilder()
      .setTitle('🤖 Available Models')
      .setColor(0x5865f2);

    for (const model of MODEL_REGISTRY) {
      const priceStr = model.pricing.inputPerMTok === 0
        ? 'Free tier'
        : `$${model.pricing.inputPerMTok} / $${model.pricing.outputPerMTok} per 1M tokens`;

      embed.addFields({
        name: `${model.displayName} (\`${model.alias}\`)`,
        value: [
          `📦 Provider: ${model.provider}`,
          `📏 Context: ${(model.contextWindow / 1024).toFixed(0)}K`,
          `💰 Pricing: ${priceStr}`,
          `🔗 API: \`${model.apiId}\``,
        ].join('\n'),
        inline: true,
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }
};
