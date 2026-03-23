/**
 * SDK AskUserQuestion interaction handlers
 *
 * Custom ID format: sdk_askq:{requestId}:{qIdx}:{optIdx|other}
 * Submits answers via state.sdkAskQuestionResolvers
 */

import { discordLogger as log } from '../../utils/logger.js';
import { createAskQuestionHandlers } from './ask-question-factory.js';

const handlers = createAskQuestionHandlers({
  prefix: {
    button: 'sdk_askq',
    submit: 'sdk_askq_submit',
    select: 'sdk_askq_select',
    modal: 'sdk_askq_modal',
  },
  onSubmitAnswers: (context, requestId, _sessionId, answers) => {
    const resolver = context.state.sdkAskQuestionResolvers.get(requestId);
    if (resolver) {
      resolver(answers);
    } else {
      log.warn({ requestId }, 'SDK AskUserQuestion: no resolver found');
    }
  },
  label: 'SDK AskUserQuestion',
});

export const handleSdkAskQuestionButton = handlers.handleButton;
export const handleSdkAskQuestionSubmit = handlers.handleSubmit;
export const handleSdkAskQuestionSelect = handlers.handleSelect;
export const handleSdkAskQuestionModal = handlers.handleModal;
