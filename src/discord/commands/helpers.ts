/**
 * Shared helpers for command handlers
 */

import type { CommandHandler } from './types.js';
import { createPtyTransport, type ClaudeTransport } from '../claude-transport.js';

/**
 * Validate session context from channel/thread ID.
 * Returns sessionId or an error message.
 */
export function getSessionFromChannel(
  channelId: string,
  context: Parameters<CommandHandler>[1]
): { sessionId: string } | { error: string } {
  const { channelManager } = context;

  // Check PTY session first
  const sessionId = channelManager.getSessionByChannel(channelId);
  if (sessionId) {
    const channel = channelManager.getSession(sessionId);
    if (channel && channel.status !== 'ended') {
      return { sessionId };
    }
  }

  // Check SDK session
  const sdkSessionId = channelManager.getSdkSessionByThread(channelId);
  if (sdkSessionId) {
    const sdkMapping = channelManager.getSdkSession(sdkSessionId);
    if (sdkMapping && sdkMapping.status !== 'ended') {
      return { sessionId: sdkSessionId };
    }
  }

  return { error: 'This channel is not associated with an active session.' };
}

/**
 * Resolve the active Claude transport for a channel/thread.
 * SDK support is optional and falls back to the legacy PTY lookup.
 */
export function getTransportFromChannel(
  channelId: string,
  context: Parameters<CommandHandler>[1]
): { transport: ClaudeTransport } | { error: string } {
  const sdkSession = context.claudeSdkSessionManager?.getSessionByThread(channelId);
  if (sdkSession) {
    return { transport: sdkSession.transport };
  }

  const sessionResult = getSessionFromChannel(channelId, context);
  if ('error' in sessionResult) {
    return sessionResult;
  }

  return {
    transport: createPtyTransport(
      sessionResult.sessionId,
      context.sessionManager,
      context.processManager,
    ),
  };
}
