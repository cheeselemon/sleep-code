/**
 * Interaction router for buttons, select menus, and modals
 */

import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import { handlePermissionButton } from './permissions.js';
import {
  handleAskQuestionButton,
  handleAskQuestionSubmit,
  handleAskQuestionSelect,
  handleAskQuestionModal,
} from './ask-question.js';
import {
  handleSdkAskQuestionButton,
  handleSdkAskQuestionSubmit,
  handleSdkAskQuestionSelect,
  handleSdkAskQuestionModal,
} from './sdk-ask-question.js';
import { handleInterruptButton, handleYoloButton } from './panel.js';
import { handleFullResultButton } from './full-result.js';
import { handleRestoreButton, handleDismissRestoreButton, handleRestoreSdkButton, handleDismissSdkButton } from './restore.js';
import { handleKillAllButton } from '../control-panel.js';
import {
  handleStartDirSelect,
  handleStopSessionSelect,
  handleRemoveDirSelect,
  handleSetTerminalSelect,
  handleCodexStartDirSelect,
  handleCodexStopSessionSelect,
  handleSdkStartDirSelect,
} from './select-menus.js';
import type { InteractionContext } from './types.js';

/**
 * Handle button interactions
 */
export async function handleButton(
  interaction: ButtonInteraction,
  context: InteractionContext
): Promise<void> {
  const customId = interaction.customId;

  // Restore session button
  if (customId.startsWith('restore:')) {
    await handleRestoreButton(interaction, context);
    return;
  }

  // Dismiss restore button
  if (customId.startsWith('dismiss_restore:')) {
    await handleDismissRestoreButton(interaction, context);
    return;
  }

  // Restore SDK session button
  if (customId.startsWith('restore_sdk:')) {
    await handleRestoreSdkButton(interaction, context);
    return;
  }

  // Dismiss SDK restore button
  if (customId.startsWith('dismiss_sdk:')) {
    await handleDismissSdkButton(interaction, context);
    return;
  }

  // View Full button for truncated results
  if (customId.startsWith('fullresult:')) {
    await handleFullResultButton(interaction, context);
    return;
  }

  // Interrupt button
  if (customId.startsWith('interrupt:')) {
    await handleInterruptButton(interaction, context);
    return;
  }

  // YOLO toggle button
  if (customId.startsWith('yolo:')) {
    await handleYoloButton(interaction, context);
    return;
  }

  // Control panel buttons
  if (customId === 'control:kill_all') {
    await handleKillAllButton(interaction, context);
    return;
  }

  // Permission request buttons
  if (customId.startsWith('perm:')) {
    await handlePermissionButton(interaction, context);
    return;
  }

  // SDK AskUserQuestion submit button
  if (customId.startsWith('sdk_askq_submit:')) {
    await handleSdkAskQuestionSubmit(interaction, context);
    return;
  }

  // SDK AskUserQuestion buttons
  if (customId.startsWith('sdk_askq:')) {
    await handleSdkAskQuestionButton(interaction, context);
    return;
  }

  // MultiSelect Submit button
  if (customId.startsWith('askq_submit:')) {
    await handleAskQuestionSubmit(interaction, context);
    return;
  }

  // AskUserQuestion buttons
  if (customId.startsWith('askq:')) {
    await handleAskQuestionButton(interaction, context);
    return;
  }
}

/**
 * Handle select menu interactions
 */
export async function handleSelectMenu(
  interaction: StringSelectMenuInteraction,
  context: InteractionContext
): Promise<void> {
  const customId = interaction.customId;

  // Claude start directory selection
  if (customId === 'claude_start_dir') {
    await handleStartDirSelect(interaction, context);
    return;
  }

  // Claude SDK start directory selection
  if (customId === 'claude_sdk_start_dir') {
    await handleSdkStartDirSelect(interaction, context);
    return;
  }

  // Claude stop session selection
  if (customId === 'claude_stop_session') {
    await handleStopSessionSelect(interaction, context);
    return;
  }

  // Claude remove directory selection
  if (customId === 'claude_remove_dir') {
    await handleRemoveDirSelect(interaction, context);
    return;
  }

  // Claude set terminal selection
  if (customId === 'claude_set_terminal') {
    await handleSetTerminalSelect(interaction, context);
    return;
  }

  // Codex start directory selection
  if (customId === 'codex_start_dir') {
    await handleCodexStartDirSelect(interaction, context);
    return;
  }

  // Codex stop session selection
  if (customId === 'codex_stop_session') {
    await handleCodexStopSessionSelect(interaction, context);
    return;
  }

  // SDK AskUserQuestion multi-select
  if (customId.startsWith('sdk_askq_select:')) {
    await handleSdkAskQuestionSelect(interaction, context);
    return;
  }

  // AskUserQuestion multi-select
  if (customId.startsWith('askq_select:')) {
    await handleAskQuestionSelect(interaction, context);
    return;
  }
}

/**
 * Handle modal submit interactions
 */
export async function handleModal(
  interaction: ModalSubmitInteraction,
  context: InteractionContext
): Promise<void> {
  const customId = interaction.customId;

  // SDK AskUserQuestion "Other" modal
  if (customId.startsWith('sdk_askq_modal:')) {
    await handleSdkAskQuestionModal(interaction, context);
    return;
  }

  // AskUserQuestion "Other" modal
  if (customId.startsWith('askq_modal:')) {
    await handleAskQuestionModal(interaction, context);
    return;
  }
}

export type { InteractionContext } from './types.js';
