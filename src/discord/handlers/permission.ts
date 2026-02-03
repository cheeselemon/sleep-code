/**
 * Permission request handler
 * - onPermissionRequest
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import { getThread } from '../utils.js';
import type { HandlerContext } from './types.js';
import type { PermissionRequestInfo } from '../../slack/session-manager.js';

export function createPermissionRequestHandler(context: HandlerContext) {
  const { client, channelManager, state } = context;

  return (request: PermissionRequestInfo): Promise<{ behavior: 'allow' | 'deny'; message?: string }> => {
    return new Promise((resolve) => {
      // YOLO mode: auto-approve without asking
      if (state.yoloSessions.has(request.sessionId)) {
        log.info({ tool: request.toolName }, 'YOLO mode: auto-approving');
        // Notify in thread
        getThread(client, channelManager, request.sessionId).then(thread => {
          if (thread) {
            thread.send(`🔥 **YOLO**: Auto-approved \`${request.toolName}\``)
              .then(() => log.debug('YOLO notification sent'))
              .catch((err) => log.error({ error: err.message }, 'YOLO notification failed'));
          } else {
            log.warn({ sessionId: request.sessionId }, 'YOLO: No thread found for session');
          }
        });
        resolve({ behavior: 'allow' });
        return;
      }

      // Store the resolver for when user clicks a button
      state.pendingPermissions.set(request.requestId, {
        requestId: request.requestId,
        sessionId: request.sessionId,
        resolve,
      });

      // Format tool input summary
      const MAX_INPUT_LENGTH = 500;
      let inputSummary = '';
      if (request.toolName === 'Bash' && request.toolInput?.command) {
        inputSummary = `\`\`\`\n${request.toolInput.command.slice(0, MAX_INPUT_LENGTH)}\n\`\`\``;
      } else if (request.toolInput?.file_path) {
        inputSummary = `\`${request.toolInput.file_path}\``;
      } else if (request.toolInput) {
        inputSummary = `\`\`\`json\n${JSON.stringify(request.toolInput, null, 2).slice(0, MAX_INPUT_LENGTH)}\n\`\`\``;
      }

      const text = `🔐 **Permission Request: ${request.toolName}**\n${inputSummary}`;

      // Create buttons: Allow, YOLO, Deny
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`perm:${request.requestId}:allow`)
          .setLabel('Allow')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`perm:${request.requestId}:yolo`)
          .setLabel('🔥 YOLO')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`perm:${request.requestId}:deny`)
          .setLabel('Deny')
          .setStyle(ButtonStyle.Danger),
      );

      // Send to thread
      const sendToThread = async () => {
        try {
          const thread = await getThread(client, channelManager, request.sessionId);
          if (thread) {
            await thread.send({ content: text, components: [row] });
            return;
          }

          // Fallback 1: find matching session in active sessions
          log.warn({ sessionId: request.sessionId }, 'No thread found for permission request, trying active sessions');
          const active = channelManager.getAllActive();
          const matchingActive = active.find(s => s.sessionId === request.sessionId);
          if (matchingActive) {
            const fallbackThread = await client.channels.fetch(matchingActive.threadId);
            if (fallbackThread?.isThread()) {
              await fallbackThread.send({ content: text, components: [row] });
              return;
            }
          }

          // Fallback 2: persisted mappings (after PM2 restart)
          log.warn({ sessionId: request.sessionId }, 'No active sessions, trying persisted mappings');
          const persisted = channelManager.getPersistedMapping(request.sessionId);
          if (persisted) {
            try {
              const persistedThread = await client.channels.fetch(persisted.threadId);
              if (persistedThread?.isThread()) {
                // Unarchive if archived
                if (persistedThread.archived) {
                  log.info({ threadId: persisted.threadId }, 'Unarchiving thread for permission request');
                  await persistedThread.setArchived(false);
                }
                log.info({ threadId: persisted.threadId }, 'Using persisted thread for permission request');
                await persistedThread.send({ content: text, components: [row] });
                return;
              }
            } catch (err) {
              log.warn({ err }, 'Failed to fetch persisted thread');
            }
          }

          // No thread available, auto-allow (local development mode)
          log.warn('No threads available, auto-allowing permission (local mode)');
          resolve({ behavior: 'allow' });
          state.pendingPermissions.delete(request.requestId);
        } catch (err) {
          log.error({ err }, 'Failed to post permission request');
          resolve({ behavior: 'deny', message: 'Failed to post to Discord' });
          state.pendingPermissions.delete(request.requestId);
        }
      };

      sendToThread();

      // No timeout - wait indefinitely for user response
    });
  };
}
