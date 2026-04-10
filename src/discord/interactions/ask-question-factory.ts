/**
 * Factory for AskUserQuestion interaction handlers.
 * Eliminates duplication between PTY (ask-question.ts) and SDK (sdk-ask-question.ts).
 *
 * The two variants differ only in:
 *   1. Discord custom ID prefix (askq vs sdk_askq)
 *   2. How collected answers are submitted (SessionManager vs sdkAskQuestionResolvers)
 *
 * Everything else — button handling, select menu, modal, answer collection — is identical.
 */

import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import { getAllAnswers, cleanupQuestionState, type PendingAnswerValue } from '../state.js';
import type { ButtonHandler, SelectMenuHandler, ModalHandler, InteractionContext } from './types.js';

export interface AskQuestionConfig {
  /** Custom ID prefixes for Discord components */
  prefix: {
    button: string;   // e.g. 'askq' or 'sdk_askq'
    submit: string;   // e.g. 'askq_submit' or 'sdk_askq_submit'
    select: string;   // e.g. 'askq_select' or 'sdk_askq_select'
    modal: string;    // e.g. 'askq_modal' or 'sdk_askq_modal'
  };
  /** Called when all answers are collected */
  onSubmitAnswers: (
    context: InteractionContext,
    requestId: string,
    sessionId: string,
    answers: Record<string, PendingAnswerValue>,
  ) => void;
  /** Label for log messages */
  label: string;
}

export interface AskQuestionHandlers {
  handleButton: ButtonHandler;
  handleSubmit: ButtonHandler;
  handleSelect: SelectMenuHandler;
  handleModal: ModalHandler;
}

export function createAskQuestionHandlers(config: AskQuestionConfig): AskQuestionHandlers {
  const { prefix, onSubmitAnswers, label } = config;

  function trySubmitAllAnswers(
    context: Parameters<ButtonHandler>[1],
    requestId: string,
  ): boolean {
    const { state } = context;
    const pending = state.pendingQuestions.get(requestId);
    if (!pending) return false;

    const answers = getAllAnswers(state, requestId);
    if (!answers) {
      log.debug({ requestId }, `${label}: not all questions answered yet`);
      return false;
    }

    log.info({ requestId, answers }, `${label}: all answered, submitting`);
    onSubmitAnswers(context, requestId, pending.sessionId, answers);
    cleanupQuestionState(state, requestId);
    return true;
  }

  // ── Single-select option button (prefix:requestId:qIdx:optIdx) ────

  const handleButton: ButtonHandler = async (interaction, context) => {
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
        .setCustomId(`${prefix.modal}:${requestId}:${qIdx}`)
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
    state.pendingAnswers.set(answerKey, { kind: 'option', label: selectedOption.label, optionIndex: optIdx });

    await interaction.update({
      content: `✅ **${question.header}**: ${selectedOption.label}`,
      components: [],
    });

    trySubmitAllAnswers(context, requestId);
  };

  // ── MultiSelect submit button (prefix_submit:requestId:qIdx) ────

  const handleSubmit: ButtonHandler = async (interaction, context) => {
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
    state.pendingAnswers.set(answerKey, { kind: 'multi', labels: selectedLabels, hasCustom: false });

    await interaction.update({
      content: `✅ **${question.header}**: ${answerText}`,
      components: [],
    });
    state.pendingMultiSelections.delete(selectionKey);

    trySubmitAllAnswers(context, requestId);
  };

  // ── MultiSelect select menu (prefix_select:requestId:qIdx) ────

  const handleSelect: SelectMenuHandler = async (interaction, context) => {
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

  // ── Modal submit for "Other" option (prefix_modal:requestId:qIdx) ────

  const handleModal: ModalHandler = async (interaction, context) => {
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
    state.pendingAnswers.set(answerKey, { kind: 'custom', text: answer });

    await interaction.reply({
      content: `✅ **${question.header}**: ${answer}`,
    });

    trySubmitAllAnswers(context, requestId);
  };

  return { handleButton, handleSubmit, handleSelect, handleModal };
}
