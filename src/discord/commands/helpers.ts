/**
 * Shared helpers for command handlers
 */

import type { CommandHandler } from './types.js';

/**
 * Validate session context from channel/thread ID.
 * Returns sessionId or an error message.
 */
export function getSessionFromChannel(
  channelId: string,
  context: Parameters<CommandHandler>[1]
): { sessionId: string } | { error: string } {
  const { channelManager } = context;

  const sessionId = channelManager.getSessionByChannel(channelId);
  if (!sessionId) {
    return { error: 'This channel is not associated with an active session.' };
  }

  const channel = channelManager.getSession(sessionId);
  if (!channel || channel.status === 'ended') {
    return { error: 'This session has ended.' };
  }

  return { sessionId };
}
