/**
 * Codex event handlers - converts CodexSessionManager events to Discord thread messages
 */

import type { Client, ThreadChannel } from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import { chunkMessage } from '../../slack/message-formatter.js';
import { parseRoutingDirective } from '../utils.js';
import type { ChannelManager } from '../channel-manager.js';
import { MAX_AGENT_ROUTING } from '../state.js';
import type { DiscordState } from '../state.js';
import type { SessionManager } from '../../slack/session-manager.js';
import type { CodexEvents } from './codex-session-manager.js';

interface CodexHandlerContext {
  client: Client;
  channelManager: ChannelManager;
  state: DiscordState;
  sessionManagerRef: { current: SessionManager | null };
}

async function getCodexThread(
  client: Client,
  channelManager: ChannelManager,
  sessionId: string
): Promise<ThreadChannel | null> {
  const mapping = channelManager.getCodexSession(sessionId);
  if (!mapping) {
    log.debug({ sessionId }, 'getCodexThread: No Codex session mapping');
    return null;
  }
  try {
    const thread = await client.channels.fetch(mapping.threadId);
    if (thread?.isThread()) return thread;
    log.debug({ threadId: mapping.threadId }, 'getCodexThread: Channel is not a thread');
  } catch (err) {
    log.debug({ threadId: mapping.threadId, err }, 'getCodexThread: Failed to fetch thread');
  }
  return null;
}

/**
 * Check if thread has both agents (Claude and Codex)
 */
function isMultiAgentThread(channelManager: ChannelManager, threadId: string): boolean {
  const agents = channelManager.getAgentsInThread(threadId);
  return !!(agents.claude && agents.codex);
}

export function createCodexEvents(context: CodexHandlerContext): CodexEvents {
  const { client, channelManager, state } = context;

  return {
    onSessionStart: async (sessionId, cwd, discordThreadId) => {
      log.info({ sessionId, cwd, discordThreadId }, 'Codex session started (handler)');
    },

    onSessionEnd: (sessionId) => {
      log.info({ sessionId }, 'Codex session ended (handler)');
      // Stop typing indicator
      const interval = state.typingIntervals.get(`codex:${sessionId}`);
      if (interval) {
        clearInterval(interval);
        state.typingIntervals.delete(`codex:${sessionId}`);
      }
    },

    onSessionStatus: (sessionId, status) => {
      log.debug({ sessionId, status }, 'Codex session status change');

      if (status === 'running') {
        // Start typing indicator
        const startTyping = async () => {
          const thread = await getCodexThread(client, channelManager, sessionId);
          if (thread) {
            thread.sendTyping().catch(() => {});
          }
        };
        startTyping();
        const interval = setInterval(startTyping, 8000);
        state.typingIntervals.set(`codex:${sessionId}`, interval);
      } else {
        // Stop typing indicator
        const interval = state.typingIntervals.get(`codex:${sessionId}`);
        if (interval) {
          clearInterval(interval);
          state.typingIntervals.delete(`codex:${sessionId}`);
        }
      }
    },

    onMessage: async (sessionId, content) => {
      const thread = await getCodexThread(client, channelManager, sessionId);
      if (!thread) return;

      const multiAgent = isMultiAgentThread(channelManager, thread.id);

      // Auto-route: detect @claude prefix in Codex output → forward to Claude
      if (multiAgent) {
        const agents = channelManager.getAgentsInThread(thread.id);
        const { target, cleanContent, explicit } = parseRoutingDirective(content, {
          hasClaude: !!agents.claude,
          hasCodex: !!agents.codex,
          lastActive: 'codex', // Codex is producing this, default stays codex
        });

        if (explicit && target === 'claude' && agents.claude && cleanContent.trim()) {
          const routingCount = state.agentRoutingCount.get(thread.id) ?? 0;
          if (routingCount >= MAX_AGENT_ROUTING) {
            log.info({ threadId: thread.id, routingCount }, 'Agent routing limit reached, displaying normally');
            try {
              await thread.send(`⚠️ Agent routing limit (${MAX_AGENT_ROUTING}) reached. Displaying message instead.`);
            } catch { /* ignore */ }
            // Fall through to normal display
          } else {
            const sessionManager = context.sessionManagerRef.current;
            if (sessionManager) {
              state.agentRoutingCount.set(thread.id, routingCount + 1);
              log.info({ from: 'codex', to: 'claude', count: routingCount + 1, preview: cleanContent.slice(0, 50) }, 'Agent-to-agent routing');
              await thread.send(`**Codex → Claude:** ${cleanContent.slice(0, 3900)}`);
              const messageForClaude = `Codex: ${cleanContent}\n\n(Start with @codex to reply)`;
              state.discordSentMessages.add(messageForClaude.trim());
              sessionManager.sendInput(agents.claude, messageForClaude);
              state.lastActiveAgent.set(thread.id, 'claude');
              return;
            }
          }
        }
      }

      const prefix = multiAgent ? '**Codex:** ' : '';
      const maxLen = 3900 - prefix.length;
      const chunks = chunkMessage(content, maxLen);

      try {
        for (const chunk of chunks) {
          await thread.send(`${prefix}${chunk}`);
        }
      } catch (err: any) {
        log.error({ threadId: thread.id, error: err.message }, 'Failed to send Codex message');
      }

      // Update last active agent
      state.lastActiveAgent.set(thread.id, 'codex');
    },

    onCommandExecution: async (sessionId, info) => {
      const thread = await getCodexThread(client, channelManager, sessionId);
      if (!thread) return;

      let text = `\`\`\`\n$ ${info.command}\n`;
      if (info.output) {
        const maxOutput = 1500;
        const output = info.output.length > maxOutput
          ? info.output.slice(0, maxOutput) + '\n... (truncated)'
          : info.output;
        text += output + '\n';
      }
      if (info.exitCode !== undefined && info.exitCode !== 0) {
        text += `Exit code: ${info.exitCode}\n`;
      }
      text += '```';

      try {
        const chunks = chunkMessage(text, 3900);
        for (const chunk of chunks) {
          await thread.send(chunk);
        }
      } catch (err: any) {
        log.error({ threadId: thread.id, error: err.message }, 'Failed to send Codex command execution');
      }
    },

    onFileChange: async (sessionId, info) => {
      const thread = await getCodexThread(client, channelManager, sessionId);
      if (!thread) return;

      const changeLines = info.changes.map(c => {
        let line = `• \`${c.path}\` (${c.kind})`;
        if (c.diff) {
          const diffPreview = c.diff.length > 200
            ? c.diff.slice(0, 200) + '...'
            : c.diff;
          line += `\n\`\`\`diff\n${diffPreview}\n\`\`\``;
        }
        return line;
      });

      const text = `📝 **File changes:**\n${changeLines.join('\n')}`;

      try {
        const chunks = chunkMessage(text, 3900);
        for (const chunk of chunks) {
          await thread.send(chunk);
        }
      } catch (err: any) {
        log.error({ threadId: thread.id, error: err.message }, 'Failed to send Codex file change');
      }
    },

    onError: (sessionId, error) => {
      log.error({ sessionId, error: error.message }, 'Codex session error');
      getCodexThread(client, channelManager, sessionId).then(thread => {
        if (thread) {
          thread.send(`❌ **Codex Error:** ${error.message}`).catch(() => {});
        }
      });
    },
  };
}
