/**
 * Message handlers
 * - onMessage
 * - onTodos
 */

import { AttachmentBuilder } from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import { chunkMessage, formatTodos } from '../../slack/message-formatter.js';
import { extractImagePaths } from '../../utils/image-extractor.js';
import { getThread } from '../utils.js';
import type { HandlerContext } from './types.js';
import type { SessionManagerRef } from './index.js';

export function createMessageHandler(context: HandlerContext, sessionManagerRef: SessionManagerRef) {
  const { client, channelManager, state } = context;

  return async (sessionId: string, role: string, content: string) => {
    log.info({ sessionId, role, contentPreview: content.slice(0, 50) }, 'onMessage');
    const thread = await getThread(client, channelManager, sessionId);
    if (!thread) {
      log.warn({ sessionId }, 'No thread found for session');
      return;
    }
    log.debug({ threadId: thread.id, sessionId }, 'Found thread for session');

    const formatted = content;

    if (role === 'user') {
      // Skip messages that originated from Discord
      const contentKey = content.trim();
      if (state.discordSentMessages.has(contentKey)) {
        state.discordSentMessages.delete(contentKey);
        log.debug('Skipping Discord-originated message');
        return;
      }

      // User message from terminal
      // Discord has 4000 char limit, leave room for "**User:** " prefix
      const chunks = chunkMessage(formatted, 3900);
      try {
        for (const chunk of chunks) {
          await thread.send(`**User:** ${chunk}`);
        }
        log.debug('Sent user message to thread');
      } catch (err: any) {
        log.error({ threadId: thread.id, error: err.message }, 'Failed to send user message to thread');
      }
    } else {
      // Title updates disabled due to Discord rate limits
      const pendingTitle = state.pendingTitles.get(sessionId);
      if (pendingTitle) {
        state.pendingTitles.delete(sessionId);
      }

      // Claude's response - Discord has 4000 char limit
      const chunks = chunkMessage(formatted, 3900);
      log.debug({ chunks: chunks.length, threadId: thread.id }, 'Sending chunks to thread');
      try {
        for (const chunk of chunks) {
          log.trace({ preview: chunk.slice(0, 80) }, 'Chunk preview');
          const msg = await thread.send(chunk);
          log.debug({ messageId: msg.id }, 'Sent message');
        }
        log.debug('Sent assistant message');
      } catch (err: any) {
        log.error({ threadId: thread.id, error: err.message }, 'Failed to send assistant message');
      }

      // Extract and upload any images mentioned in the response
      const sessionManager = sessionManagerRef.current;
      if (sessionManager) {
        const session = sessionManager.getSession(sessionId);
        const images = extractImagePaths(content, session?.cwd);
        for (const image of images) {
          try {
            log.info({ path: image.resolvedPath }, 'Uploading image');
            const attachment = new AttachmentBuilder(image.resolvedPath);
            await thread.send({
              content: `📎 ${image.originalPath}`,
              files: [attachment],
            });
          } catch (err) {
            log.error({ err }, 'Failed to upload image');
          }
        }
      }
    }
  };
}

export function createTodosHandler(context: HandlerContext) {
  const { client, channelManager } = context;

  return async (sessionId: string, todos: import('../../types.js').TodoItem[]) => {
    if (todos.length > 0) {
      const todosText = formatTodos(todos);
      try {
        const thread = await getThread(client, channelManager, sessionId);
        if (thread) {
          await thread.send(`**Tasks:**\n${todosText}`);
        }
      } catch (err) {
        log.error({ err }, 'Failed to post todos');
      }
    }
  };
}
