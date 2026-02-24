/**
 * Panel button handlers (interrupt:*, yolo:*)
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { ButtonHandler } from './types.js';

/**
 * Handle interrupt button (interrupt:sessionId)
 */
export const handleInterruptButton: ButtonHandler = async (interaction, context) => {
  const { sessionManager } = context;
  const customId = interaction.customId;

  const sessionId = customId.slice('interrupt:'.length);
  const sent = sessionManager.sendInput(sessionId, '\x1b'); // Escape
  if (sent) {
    await interaction.reply({ content: '🛑 Interrupt sent', ephemeral: true });
  } else {
    await interaction.reply({ content: '⚠️ Session not found', ephemeral: true });
  }
};

/**
 * Handle YOLO toggle button (yolo:sessionId)
 */
export const handleYoloButton: ButtonHandler = async (interaction, context) => {
  const { state, codexSessionManager } = context;
  const customId = interaction.customId;

  const sessionId = customId.slice('yolo:'.length);
  const isYolo = state.yoloSessions.has(sessionId);

  // Toggle state
  if (isYolo) {
    state.yoloSessions.delete(sessionId);
  } else {
    state.yoloSessions.add(sessionId);
  }
  const newState = !isYolo;

  // Switch Codex sandbox mode if present in this thread
  const codexSession = codexSessionManager?.getSessionByDiscordThread(interaction.channelId);
  if (codexSession) {
    await codexSessionManager!.switchSandboxMode(
      codexSession.id,
      newState ? 'workspace-write' : 'read-only',
    );
  }

  // Update button label
  const updatedButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`interrupt:${sessionId}`)
      .setLabel('🛑 Interrupt')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`yolo:${sessionId}`)
      .setLabel(newState ? '🔥 YOLO: ON' : '🛡️ YOLO: OFF')
      .setStyle(newState ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  await interaction.update({ components: [updatedButton] });
};
