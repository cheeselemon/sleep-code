/**
 * AskUserQuestion interaction handlers
 * - askq:* buttons (single select)
 * - askq_select:* select menus (multi select)
 * - askq_submit:* buttons (submit multi select)
 * - askq_modal:* modals (custom text input)
 */

import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import { getAllAnswers, cleanupQuestionState } from '../state.js';
import type { ButtonHandler, SelectMenuHandler, ModalHandler } from './types.js';

/**
 * Try to submit all answers if all questions are answered
 */
function trySubmitAllAnswers(
  context: Parameters<ButtonHandler>[1],
  toolUseId: string
): boolean {
  const { state, sessionManager } = context;
  const pending = state.pendingQuestions.get(toolUseId);
  if (!pending) return false;

  const answers = getAllAnswers(state, toolUseId);
  if (!answers) {
    log.debug({ toolUseId }, 'Not all questions answered yet');
    return false;
  }

  // All questions answered, submit
  log.info({ toolUseId, answers }, 'All questions answered, submitting');
  sessionManager.allowPendingAskUserQuestion(pending.sessionId, answers);

  // Cleanup
  cleanupQuestionState(state, toolUseId);
  return true;
}

/**
 * Handle single-select option buttons (askq:toolUseId:qIdx:optIdx)
 */
export const handleAskQuestionButton: ButtonHandler = async (interaction, context) => {
  const { state } = context;
  const customId = interaction.customId;

  const parts = customId.split(':');
  if (parts.length !== 4) return;

  const [, toolUseId, qIdxStr, optionPart] = parts;
  const pending = state.pendingQuestions.get(toolUseId);
  if (!pending) {
    await interaction.reply({ content: '⚠️ This question has expired.', ephemeral: true });
    return;
  }

  const qIdx = parseInt(qIdxStr, 10);
  const question = pending.questions[qIdx];
  if (!question) {
    await interaction.reply({ content: '⚠️ Invalid question.', ephemeral: true });
    return;
  }

  // Handle "Other" option - show modal
  if (optionPart === 'other') {
    const modal = new ModalBuilder()
      .setCustomId(`askq_modal:${toolUseId}:${qIdx}`)
      .setTitle(question.header.slice(0, 45));

    const textInput = new TextInputBuilder()
      .setCustomId('answer')
      .setLabel(question.question.slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Enter your answer...')
      .setRequired(true);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
    return;
  }

  // Handle option selection
  const optIdx = parseInt(optionPart, 10);
  const selectedOption = question.options[optIdx];
  if (!selectedOption) {
    await interaction.reply({ content: '⚠️ Invalid option.', ephemeral: true });
    return;
  }

  // Store the answer
  const answerKey = `${toolUseId}:${qIdx}`;
  state.pendingAnswers.set(answerKey, selectedOption.label);

  // Update this message to show selected answer
  await interaction.update({
    content: `✅ **${question.header}**: ${selectedOption.label}`,
    components: [], // Remove buttons
  });

  // Try to submit if all questions answered
  trySubmitAllAnswers(context, toolUseId);
};

/**
 * Handle multiSelect submit button (askq_submit:toolUseId:qIdx)
 */
export const handleAskQuestionSubmit: ButtonHandler = async (interaction, context) => {
  const { state } = context;
  const customId = interaction.customId;

  const parts = customId.split(':');
  if (parts.length !== 3) return;

  const [, toolUseId, qIdxStr] = parts;
  const pending = state.pendingQuestions.get(toolUseId);
  if (!pending) {
    await interaction.reply({ content: '⚠️ This question has expired.', ephemeral: true });
    return;
  }

  const qIdx = parseInt(qIdxStr, 10);
  const question = pending.questions[qIdx];
  if (!question) {
    await interaction.reply({ content: '⚠️ Invalid question.', ephemeral: true });
    return;
  }

  // Get stored selections
  const selectionKey = `${toolUseId}:${qIdx}`;
  const selectedValues = state.pendingMultiSelections.get(selectionKey);
  if (!selectedValues || selectedValues.length === 0) {
    await interaction.reply({ content: '⚠️ Please select at least one option first.', ephemeral: true });
    return;
  }

  // Get selected option labels
  const selectedLabels = selectedValues.map((val) => {
    const optIdx = parseInt(val, 10);
    return question.options[optIdx]?.label || val;
  });

  // Store the answer
  const answerText = selectedLabels.join(', ');
  const answerKey = `${toolUseId}:${qIdx}`;
  state.pendingAnswers.set(answerKey, answerText);

  await interaction.update({
    content: `✅ **${question.header}**: ${answerText}`,
    components: [], // Remove all components
  });
  state.pendingMultiSelections.delete(selectionKey);

  // Try to submit if all questions answered
  trySubmitAllAnswers(context, toolUseId);
};

/**
 * Handle multiSelect select menu (askq_select:toolUseId:qIdx)
 */
export const handleAskQuestionSelect: SelectMenuHandler = async (interaction, context) => {
  const { state } = context;
  const customId = interaction.customId;

  const parts = customId.split(':');
  if (parts.length !== 3) return;

  const [, toolUseId, qIdxStr] = parts;
  const pending = state.pendingQuestions.get(toolUseId);
  if (!pending) {
    await interaction.reply({ content: '⚠️ This question has expired.', ephemeral: true });
    return;
  }

  const qIdx = parseInt(qIdxStr, 10);
  const question = pending.questions[qIdx];
  if (!question) {
    await interaction.reply({ content: '⚠️ Invalid question.', ephemeral: true });
    return;
  }

  // Store selected values for later submit
  const selectionKey = `${toolUseId}:${qIdx}`;
  state.pendingMultiSelections.set(selectionKey, interaction.values);

  // Get selected option labels for display
  const selectedLabels = interaction.values.map((val) => {
    const optIdx = parseInt(val, 10);
    return question.options[optIdx]?.label || val;
  });

  // Update message to show current selection (don't submit yet)
  await interaction.update({
    content: `❓ **${question.header}**\n${question.question}\n\n✏️ Selected: ${selectedLabels.join(', ')}\n\n*Click Submit to confirm*`,
  });
};

/**
 * Handle modal submit for "Other" option (askq_modal:toolUseId:qIdx)
 */
export const handleAskQuestionModal: ModalHandler = async (interaction, context) => {
  const { state } = context;
  const customId = interaction.customId;

  const parts = customId.split(':');
  if (parts.length !== 3) return;

  const [, toolUseId, qIdxStr] = parts;
  const pending = state.pendingQuestions.get(toolUseId);
  if (!pending) {
    await interaction.reply({ content: '⚠️ This question has expired.', ephemeral: true });
    return;
  }

  const qIdx = parseInt(qIdxStr, 10);
  const question = pending.questions[qIdx];
  if (!question) {
    await interaction.reply({ content: '⚠️ Invalid question.', ephemeral: true });
    return;
  }

  const answer = interaction.fields.getTextInputValue('answer');

  // Store the answer
  const answerKey = `${toolUseId}:${qIdx}`;
  state.pendingAnswers.set(answerKey, answer);

  await interaction.reply({
    content: `✅ **${question.header}**: ${answer}`,
  });

  // Try to submit if all questions answered
  trySubmitAllAnswers(context, toolUseId);
};
