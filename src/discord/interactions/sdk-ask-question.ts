/**
 * SDK AskUserQuestion interaction handlers
 * Mirrors PTY ask-question.ts but resolves via sdkAskQuestionResolvers
 * instead of sessionManager.allowPendingAskUserQuestion
 *
 * Custom ID format: sdk_askq:{requestId}:{qIdx}:{optIdx|other}
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
 * Try to submit all answers if all questions are answered (SDK version)
 */
function trySubmitAllAnswers(
  context: Parameters<ButtonHandler>[1],
  requestId: string,
): boolean {
  const { state } = context;
  const pending = state.pendingQuestions.get(requestId);
  if (!pending) return false;

  const answers = getAllAnswers(state, requestId);
  if (!answers) {
    log.debug({ requestId }, 'SDK AskUserQuestion: not all questions answered yet');
    return false;
  }

  // All questions answered — resolve the SDK canUseTool promise
  const resolver = state.sdkAskQuestionResolvers.get(requestId);
  if (resolver) {
    log.info({ requestId, answers }, 'SDK AskUserQuestion: all answered, resolving');
    resolver(answers);
  } else {
    log.warn({ requestId }, 'SDK AskUserQuestion: no resolver found');
  }

  cleanupQuestionState(state, requestId);
  return true;
}

/**
 * Handle single-select option buttons (sdk_askq:requestId:qIdx:optIdx)
 */
export const handleSdkAskQuestionButton: ButtonHandler = async (interaction, context) => {
  const { state } = context;
  const parts = interaction.customId.split(':');
  if (parts.length !== 4) return;

  const [, requestId, qIdxStr, optionPart] = parts;
  const pending = state.pendingQuestions.get(requestId);
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

  // Handle "Other" option — show modal
  if (optionPart === 'other') {
    const modal = new ModalBuilder()
      .setCustomId(`sdk_askq_modal:${requestId}:${qIdx}`)
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

  const answerKey = `${requestId}:${qIdx}`;
  state.pendingAnswers.set(answerKey, selectedOption.label);

  await interaction.update({
    content: `✅ **${question.header}**: ${selectedOption.label}`,
    components: [],
  });

  trySubmitAllAnswers(context, requestId);
};

/**
 * Handle multiSelect submit button (sdk_askq_submit:requestId:qIdx)
 */
export const handleSdkAskQuestionSubmit: ButtonHandler = async (interaction, context) => {
  const { state } = context;
  const parts = interaction.customId.split(':');
  if (parts.length !== 3) return;

  const [, requestId, qIdxStr] = parts;
  const pending = state.pendingQuestions.get(requestId);
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

  const selectionKey = `${requestId}:${qIdx}`;
  const selectedValues = state.pendingMultiSelections.get(selectionKey);
  if (!selectedValues || selectedValues.length === 0) {
    await interaction.reply({ content: '⚠️ Please select at least one option first.', ephemeral: true });
    return;
  }

  const selectedLabels = selectedValues.map((val) => {
    const optIdx = parseInt(val, 10);
    return question.options[optIdx]?.label || val;
  });

  const answerText = selectedLabels.join(', ');
  const answerKey = `${requestId}:${qIdx}`;
  state.pendingAnswers.set(answerKey, answerText);

  await interaction.update({
    content: `✅ **${question.header}**: ${answerText}`,
    components: [],
  });
  state.pendingMultiSelections.delete(selectionKey);

  trySubmitAllAnswers(context, requestId);
};

/**
 * Handle multiSelect select menu (sdk_askq_select:requestId:qIdx)
 */
export const handleSdkAskQuestionSelect: SelectMenuHandler = async (interaction, context) => {
  const { state } = context;
  const parts = interaction.customId.split(':');
  if (parts.length !== 3) return;

  const [, requestId, qIdxStr] = parts;
  const pending = state.pendingQuestions.get(requestId);
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

  const selectionKey = `${requestId}:${qIdx}`;
  state.pendingMultiSelections.set(selectionKey, interaction.values);

  const selectedLabels = interaction.values.map((val) => {
    const optIdx = parseInt(val, 10);
    return question.options[optIdx]?.label || val;
  });

  await interaction.update({
    content: `❓ **${question.header}**\n${question.question}\n\n✏️ Selected: ${selectedLabels.join(', ')}\n\n*Click Submit to confirm*`,
  });
};

/**
 * Handle modal submit for "Other" option (sdk_askq_modal:requestId:qIdx)
 */
export const handleSdkAskQuestionModal: ModalHandler = async (interaction, context) => {
  const { state } = context;
  const parts = interaction.customId.split(':');
  if (parts.length !== 3) return;

  const [, requestId, qIdxStr] = parts;
  const pending = state.pendingQuestions.get(requestId);
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
  const answerKey = `${requestId}:${qIdx}`;
  state.pendingAnswers.set(answerKey, answer);

  await interaction.reply({
    content: `✅ **${question.header}**: ${answer}`,
  });

  trySubmitAllAnswers(context, requestId);
};
