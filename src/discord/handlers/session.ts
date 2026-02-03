/**
 * Session lifecycle handlers
 * - onSessionStart
 * - onSessionEnd
 * - onSessionUpdate
 * - onSessionStatus
 * - onTitleChange
 */

import { formatSessionStatus } from '../../slack/message-formatter.js';
import { getThread } from '../utils.js';
import type { HandlerContext } from './types.js';
import type { SessionInfo } from '../../slack/session-manager.js';

export function createSessionStartHandler(context: HandlerContext) {
  const { client, channelManager, processManager, state } = context;

  return async (session: SessionInfo) => {
    // Notify ProcessManager that session connected
    if (processManager) {
      const result = await processManager.onSessionConnected(session.id, session.cwd, session.pid);

      // If session wasn't in registry, add it (manual start via CLI)
      if (!result.found) {
        await processManager.addManualSession(session.id, session.cwd, session.pid);
      }
    }

    const mapping = await channelManager.createSession(session.id, session.name, session.cwd);
    if (mapping) {
      // Store threadId in ProcessManager registry for recovery after bot restart
      if (processManager && mapping.threadId) {
        await processManager.setThreadId(session.id, mapping.threadId);
      }

      const thread = await getThread(client, channelManager, session.id);
      if (thread) {
        // Send session started message
        await thread.send(
          `${formatSessionStatus(session.status)} **Session started**\n\`${session.cwd}\`\nUse \`/panel\` for controls`
        );

        // Apply pending title if one was received before thread creation
        // Title updates disabled due to Discord rate limits
        const pendingTitle = state.pendingTitles.get(session.id);
        if (pendingTitle) {
          state.pendingTitles.delete(session.id);
        }
      }
    }
  };
}

export function createSessionEndHandler(context: HandlerContext) {
  const { client, channelManager, processManager, state } = context;

  return async (sessionId: string) => {
    // Clean up typing indicator to prevent resource leak
    const typingInterval = state.typingIntervals.get(sessionId);
    if (typingInterval) {
      clearInterval(typingInterval);
      state.typingIntervals.delete(sessionId);
    }

    // Update ProcessManager status
    if (processManager) {
      await processManager.updateStatus(sessionId, 'stopped');
    }

    const session = channelManager.getSession(sessionId);
    if (session) {
      const thread = await getThread(client, channelManager, sessionId);
      if (thread) {
        await thread.send('🛑 **Session ended** - this thread will be archived');
      }

      await channelManager.archiveSession(sessionId);
    }
  };
}

export function createSessionUpdateHandler(context: HandlerContext) {
  const { channelManager } = context;

  return async (sessionId: string, name: string) => {
    const session = channelManager.getSession(sessionId);
    if (session) {
      channelManager.updateName(sessionId, name);
      // Title updates disabled due to Discord rate limits
    }
  };
}

export function createSessionStatusHandler(context: HandlerContext) {
  const { client, channelManager, state } = context;

  return async (sessionId: string, status: string) => {
    const session = channelManager.getSession(sessionId);
    if (session) {
      channelManager.updateStatus(sessionId, status as 'running' | 'idle' | 'ended');

      // Manage typing indicator based on status
      if (status === 'running') {
        // Start typing indicator if not already running
        if (!state.typingIntervals.has(sessionId)) {
          const sendTyping = async () => {
            try {
              const thread = await getThread(client, channelManager, sessionId);
              if (thread) {
                await thread.sendTyping();
              }
            } catch {
              // Ignore typing errors
            }
          };
          // Send immediately and then every 8 seconds
          sendTyping();
          const interval = setInterval(sendTyping, 8000);
          state.typingIntervals.set(sessionId, interval);
        }
      } else {
        // Stop typing indicator
        const interval = state.typingIntervals.get(sessionId);
        if (interval) {
          clearInterval(interval);
          state.typingIntervals.delete(sessionId);
        }
      }
    }
  };
}

export function createTitleChangeHandler(context: HandlerContext) {
  const { state } = context;

  return async (sessionId: string, title: string) => {
    // Just store the title - will be applied when user sends a message
    state.pendingTitles.set(sessionId, title);
  };
}
