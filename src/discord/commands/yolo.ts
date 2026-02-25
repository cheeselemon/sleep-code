/**
 * YOLO mode commands: /yolo-sleep, /panel
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { CommandHandler } from './types.js';
import { getSessionFromChannel } from './helpers.js';

export const handleYoloSleep: CommandHandler = async (interaction, context) => {
  const { state, codexSessionManager } = context;

  const result = getSessionFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  // Toggle YOLO mode
  if (state.yoloSessions.has(result.sessionId)) {
    state.yoloSessions.delete(result.sessionId);
    // Switch Codex to read-only if present in this thread
    const codexSession = codexSessionManager?.getSessionByDiscordThread(interaction.channelId);
    if (codexSession) {
      await codexSessionManager!.switchSandboxMode(codexSession.id, 'read-only');
    }
    await interaction.reply('🛡️ **YOLO mode OFF** - Permission requests will be shown');
  } else {
    state.yoloSessions.add(result.sessionId);
    // Switch Codex to workspace-write if present in this thread
    const codexSession = codexSessionManager?.getSessionByDiscordThread(interaction.channelId);
    if (codexSession) {
      await codexSessionManager!.switchSandboxMode(codexSession.id, 'workspace-write');
    }
    await interaction.reply('🔥 **YOLO mode ON** - All permissions auto-approved!');
  }
};

export const handlePanel: CommandHandler = async (interaction, context) => {
  const { state } = context;

  const result = getSessionFromChannel(interaction.channelId, context);
  if ('error' in result) {
    await interaction.reply(`⚠️ ${result.error}`);
    return;
  }

  const isYolo = state.yoloSessions.has(result.sessionId);
  const controlButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`interrupt:${result.sessionId}`)
      .setLabel('🛑 Interrupt')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`yolo:${result.sessionId}`)
      .setLabel(isYolo ? '🔥 YOLO: ON' : '🛡️ YOLO: OFF')
      .setStyle(isYolo ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  await interaction.reply({
    content: '**Session Control Panel**',
    components: [controlButtons],
  });
};
