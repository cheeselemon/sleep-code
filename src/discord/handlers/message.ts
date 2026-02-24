/**
 * Message handlers
 * - onMessage
 * - onTodos
 */

import { AttachmentBuilder } from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import { chunkMessage, formatCommandMessage, formatTodos } from '../../slack/message-formatter.js';
import { extractImagePaths } from '../../utils/image-extractor.js';
import { getThread, parseAgentPrefix } from '../utils.js';
import { MAX_AGENT_ROUTING } from '../state.js';
import type { HandlerContext } from './types.js';
import type { SessionManagerRef } from './index.js';

export function createMessageHandler(context: HandlerContext, sessionManagerRef: SessionManagerRef) {
  const { client, channelManager, codexSessionManager, state } = context;

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
      // Format slash commands nicely
      const commandFormatted = formatCommandMessage(formatted);
      const displayContent = commandFormatted ?? formatted;

      // Discord has 4000 char limit, leave room for "**User:** " prefix
      const chunks = chunkMessage(displayContent, 3900);
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
      // Add "Claude:" prefix when both agents are in the same thread
      const agents = channelManager.getAgentsInThread(thread.id);
      const multiAgent = !!(agents.claude && agents.codex);

      // Auto-route: detect x:/codex: prefix in Claude output → forward to Codex
      if (multiAgent && codexSessionManager) {
        const { target, cleanContent } = parseAgentPrefix(formatted, {
          hasClaude: !!agents.claude,
          hasCodex: !!agents.codex,
          lastActive: 'claude', // Claude is producing this, default stays claude
        });

        if (target === 'codex' && agents.codex && cleanContent.trim()) {
          const routingCount = state.agentRoutingCount.get(thread.id) ?? 0;
          if (routingCount >= MAX_AGENT_ROUTING) {
            log.info({ threadId: thread.id, routingCount }, 'Agent routing limit reached, displaying normally');
            try {
              await thread.send(`⚠️ Agent routing limit (${MAX_AGENT_ROUTING}) reached. Displaying message instead.`);
            } catch { /* ignore */ }
            // Fall through to normal display
          } else {
            const codexSession = codexSessionManager.getSession(agents.codex);
            if (codexSession && codexSession.status !== 'ended') {
              state.agentRoutingCount.set(thread.id, routingCount + 1);
              log.info({ from: 'claude', to: 'codex', count: routingCount + 1, preview: cleanContent.slice(0, 50) }, 'Agent-to-agent routing');
              try {
                await thread.send(`**Claude → Codex:** ${cleanContent.slice(0, 3900)}`);
              } catch { /* ignore */ }
              const messageForCodex = `Claude: ${cleanContent}\n\n(Start with @claude to reply)`;
              await codexSessionManager.sendInput(agents.codex, messageForCodex);
              state.lastActiveAgent.set(thread.id, 'codex');
              return; // Skip normal Claude message display
            }
          }
        }
      }

      const prefix = multiAgent ? '**Claude:** ' : '';
      const maxLen = 3900 - prefix.length;
      const chunks = chunkMessage(formatted, maxLen);
      log.debug({ chunks: chunks.length, threadId: thread.id, multiAgent }, 'Sending chunks to thread');
      try {
        for (const chunk of chunks) {
          log.trace({ preview: chunk.slice(0, 80) }, 'Chunk preview');
          const msg = await thread.send(`${prefix}${chunk}`);
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
