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
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { DiscordState } from '../state.js';
import { SKIP_RESULT_TOOLS } from '../state.js';
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

      const input = info.input as Record<string, unknown> | null;
      let inputSummary = '';
      if (input) {
        if (info.toolName === 'Bash' && typeof input.command === 'string') {
          inputSummary = `\`${input.command.slice(0, 100)}${input.command.length > 100 ? '...' : ''}\``;
        } else if ((info.toolName === 'Read' || info.toolName === 'Edit' || info.toolName === 'Write') && typeof input.file_path === 'string') {
          inputSummary = `\`${input.file_path}\``;
        } else if ((info.toolName === 'Grep' || info.toolName === 'Glob') && typeof input.pattern === 'string') {
          inputSummary = `\`${input.pattern}\``;
        } else if (info.toolName === 'Task' && typeof input.description === 'string') {
          inputSummary = input.description as string;
        }
      }

      const text = inputSummary
        ? `🔧 **${info.toolName}**: ${inputSummary}`
        : `🔧 **${info.toolName}**`;

      try {
        const message = await thread.send(text.slice(0, DISCORD_SAFE_CONTENT_LIMIT));
        // Store for tool result reply + file upload
        if (info.toolUseId) {
          const filePath = (info.toolName === 'Write' || info.toolName === 'Edit') && input?.file_path
            ? String(input.file_path) : undefined;
          state.toolCallMessages.set(info.toolUseId, { messageId: message.id, toolName: info.toolName, filePath });
        }
      } catch (err) {
        log.error({ err }, 'Failed to post SDK tool call');
      }
    },

    onToolResult: async (sessionId, info: ClaudeSdkToolResultInfo) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      // Process each tool use ID
      for (const toolUseId of info.toolUseIds) {
        const toolInfo = state.toolCallMessages.get(toolUseId);
        state.toolCallMessages.delete(toolUseId);

        // Skip verbose tool results
        if (toolInfo && SKIP_RESULT_TOOLS.has(toolInfo.toolName)) {
          continue;
        }

        // Upload file for Write/Edit tools
        if (toolInfo?.filePath && (toolInfo.toolName === 'Write' || toolInfo.toolName === 'Edit')) {
          try {
            const attachment = new AttachmentBuilder(toolInfo.filePath);
            await thread.send({
              content: `📄 **File ${toolInfo.toolName === 'Write' ? 'created' : 'edited'}**`,
              files: [attachment],
            });
          } catch (err) {
            log.error({ err }, 'Failed to upload file from SDK session');
          }
          continue;
        }

        // Truncate long results
        const maxLen = 300;
        const fullContent = info.summary;
        const isTruncated = fullContent.length > maxLen;
        let content = fullContent;
        if (isTruncated) {
          content = fullContent.slice(0, maxLen) + '\n... (truncated)';
        }

        const text = `✅ Result:\n\`\`\`\n${content}\n\`\`\``;

        // "View Full" button if truncated
        let components: ActionRowBuilder<ButtonBuilder>[] = [];
        if (isTruncated) {
          const resultId = `${toolUseId}-${Date.now()}`;
          state.pendingFullResults.set(resultId, {
            content: fullContent,
            toolName: toolInfo?.toolName || 'unknown',
            createdAt: Date.now(),
          });
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`fullresult:${resultId}`)
              .setLabel('View Full')
              .setStyle(ButtonStyle.Secondary)
          );
          components = [row];
        }

        try {
          if (toolInfo?.messageId) {
            const parentMessage = await thread.messages.fetch(toolInfo.messageId).catch(() => null);
            if (parentMessage) {
              await parentMessage.reply({ content: text.slice(0, DISCORD_SAFE_CONTENT_LIMIT), components });
              continue;
            }
          }
          await thread.send({ content: text.slice(0, DISCORD_SAFE_CONTENT_LIMIT), components });
        } catch (err) {
          log.error({ err }, 'Failed to post SDK tool result');
        }
      }
    },

    onPermissionRequest: async (sessionId, request) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      const MAX_INPUT_LENGTH = 500;
      let inputSummary = '';
      if (request.toolName === 'Bash' && request.toolInput?.command) {
        inputSummary = `\`\`\`\n${String(request.toolInput.command).slice(0, MAX_INPUT_LENGTH)}\n\`\`\``;
      } else if (request.toolInput?.file_path) {
        inputSummary = `\`${request.toolInput.file_path}\``;
      } else if (request.toolInput) {
        inputSummary = `\`\`\`json\n${JSON.stringify(request.toolInput, null, 2).slice(0, MAX_INPUT_LENGTH)}\n\`\`\``;
      }

      const text = `🔐 **Permission Request: ${request.toolName}**\n${inputSummary}`;

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

      try {
        await thread.send({ content: text, components: [row] });
      } catch (err) {
        log.error({ err, sessionId }, 'Failed to post SDK permission request');
      }
    },

    onYoloApprove: async (sessionId, toolName) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (thread) {
        thread.send(`🔥 **YOLO**: Auto-approved \`${toolName}\``).catch(() => {});
      }
    },

    onPermissionTimeout: async (sessionId, _requestId, toolName) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (thread) {
        thread.send(`⏰ **Permission timed out**: \`${toolName}\` — auto-denied`).catch(() => {});
      }
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
