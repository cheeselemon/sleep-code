/**
 * AskUserQuestion interaction handlers (PTY sessions)
 *
 * Custom ID format: askq:{toolUseId}:{qIdx}:{optIdx|other}
 * Submits answers via sessionManager.allowPendingAskUserQuestion()
 */

import { createAskQuestionHandlers } from './ask-question-factory.js';

const handlers = createAskQuestionHandlers({
  prefix: {
    button: 'askq',
    submit: 'askq_submit',
    select: 'askq_select',
    modal: 'askq_modal',
  },
  onSubmitAnswers: (context, _requestId, sessionId, answers) => {
    context.sessionManager.allowPendingAskUserQuestion(sessionId, answers);
  },
  label: 'AskUserQuestion',
});

export const handleAskQuestionButton = handlers.handleButton;
export const handleAskQuestionSubmit = handlers.handleSubmit;
export const handleAskQuestionSelect = handlers.handleSelect;
export const handleAskQuestionModal = handlers.handleModal;
