import type { Client, ThreadChannel } from 'discord.js';
import { basename } from 'path';
import { discordLogger as log } from '../../utils/logger.js';
import { chunkMessage } from '../../slack/message-formatter.js';
import { DISCORD_SAFE_CONTENT_LIMIT } from '../constants.js';
import type { ChannelManager } from '../channel-manager.js';
import type {
  ClaudeSdkEvents,
  ClaudeSdkToolCallInfo,
  ClaudeSdkToolResultInfo,
} from './claude-sdk-session-manager.js';
import type { DiscordState } from '../state.js';
import { tryRouteToAgent } from '../agent-routing.js';
import type { CodexSessionManager } from '../codex/codex-session-manager.js';
import type { MemoryCollector } from '../../memory/memory-collector.js';

interface ClaudeSdkHandlerContext {
  client: Client;
  channelManager: ChannelManager;
  state: DiscordState;
  codexSessionManager?: CodexSessionManager;
  memoryCollector?: MemoryCollector;
}

async function getClaudeSdkThread(
  client: Client,
  channelManager: ChannelManager,
  sessionId: string,
): Promise<ThreadChannel | null> {
  const mapping = channelManager.getSdkSession(sessionId);
  if (!mapping) {
    log.debug({ sessionId }, 'getClaudeSdkThread: No SDK session mapping');
    return null;
  }

  try {
    const thread = await client.channels.fetch(mapping.threadId);
    if (thread?.isThread()) {
      return thread;
    }
  } catch (err) {
    log.debug({ sessionId, err }, 'getClaudeSdkThread: Failed to fetch thread');
  }

  return null;
}

function summarizeToolInput(info: ClaudeSdkToolCallInfo): string {
  const input = info.input as Record<string, unknown> | null;
  if (!input) {
    return '';
  }

  if (typeof input.command === 'string') {
    return `: \`${input.command.slice(0, 100)}${input.command.length > 100 ? '...' : ''}\``;
  }

  if (typeof input.file_path === 'string') {
    return `: \`${input.file_path}\``;
  }

  const json = JSON.stringify(input);
  if (!json) {
    return '';
  }

  return `: \`${json.slice(0, 100)}${json.length > 100 ? '...' : ''}\``;
}

export function createClaudeSdkHandlers(context: ClaudeSdkHandlerContext): ClaudeSdkEvents {
  const {
    channelManager,
    client,
    codexSessionManager,
    memoryCollector,
    state,
  } = context;

  return {
    onSessionStart: async (sessionId, cwd) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      try {
        await thread.send(`📡 **Claude SDK ready**\nDirectory: \`${cwd}\``);
      } catch (err) {
        log.error({ err, sessionId }, 'Failed to post Claude SDK start message');
      }
    },

    onSessionEnd: async (sessionId) => {
      const interval = state.typingIntervals.get(`claude-sdk:${sessionId}`);
      if (interval) {
        clearInterval(interval);
        state.typingIntervals.delete(`claude-sdk:${sessionId}`);
      }

      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      try {
        await thread.send('🛑 **Claude SDK session ended**');
      } catch {
        // Ignore end notification failures.
      }
    },

    onSessionStatus: (sessionId, status) => {
      channelManager.updateSdkStatus(sessionId, status);

      if (status === 'running') {
        const startTyping = async () => {
          const thread = await getClaudeSdkThread(client, channelManager, sessionId);
          if (thread) {
            thread.sendTyping().catch(() => {});
          }
        };

        startTyping();
        const interval = setInterval(startTyping, 8000);
        state.typingIntervals.set(`claude-sdk:${sessionId}`, interval);
        return;
      }

      const interval = state.typingIntervals.get(`claude-sdk:${sessionId}`);
      if (interval) {
        clearInterval(interval);
        state.typingIntervals.delete(`claude-sdk:${sessionId}`);
      }
    },

    onMessage: async (sessionId, content) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      const agents = channelManager.getAgentsInThread(thread.id);
      const multiAgent = !!(agents.claude && agents.codex);

      if (multiAgent && codexSessionManager && agents.codex) {
        const { routed } = await tryRouteToAgent({
          thread,
          content,
          agents,
          sourceAgent: 'claude',
          state,
          isTargetAvailable: () => {
            const codexSession = codexSessionManager.getSession(agents.codex!);
            return !!(codexSession && codexSession.status !== 'ended');
          },
          sendToTarget: (msg) => codexSessionManager.sendInput(agents.codex!, msg),
        });

        if (routed) {
          return;
        }
      }

      if (memoryCollector && content.trim()) {
        const mapping = channelManager.getSdkSession(sessionId);
        const project = mapping?.cwd ? basename(mapping.cwd) : undefined;
        memoryCollector.onMessage({
          speaker: 'claude',
          displayName: 'Claude',
          content,
          channelId: thread.id,
          threadId: thread.id,
          project,
        }).catch(err => log.error({ err }, 'Memory collect failed'));
      }

      const prefix = multiAgent ? '**Claude:** ' : '';
      const maxLen = DISCORD_SAFE_CONTENT_LIMIT - prefix.length;
      const chunks = chunkMessage(content, maxLen);

      for (const chunk of chunks) {
        await thread.send(`${prefix}${chunk}`);
      }

      state.lastActiveAgent.set(thread.id, 'claude');
    },

    onToolCall: async (sessionId, info) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      const summary = summarizeToolInput(info);
      await thread.send(`🔧 **${info.toolName}**${summary}`.slice(0, DISCORD_SAFE_CONTENT_LIMIT));
    },

    onToolResult: async (sessionId, info: ClaudeSdkToolResultInfo) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      const text = `✅ Tool result: ${info.summary}`.slice(0, DISCORD_SAFE_CONTENT_LIMIT);
      await thread.send(text);
    },

    onError: async (sessionId, error) => {
      log.error({ sessionId, error: error.message }, 'Claude SDK session error');

      const interval = state.typingIntervals.get(`claude-sdk:${sessionId}`);
      if (interval) {
        clearInterval(interval);
        state.typingIntervals.delete(`claude-sdk:${sessionId}`);
      }

      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      await thread.send(`❌ **Claude SDK Error:** ${error.message}`);
    },
  };
}
