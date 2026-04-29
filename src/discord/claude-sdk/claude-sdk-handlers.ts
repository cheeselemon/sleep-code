import type { Client, ThreadChannel } from 'discord.js';
import { basename } from 'path';
import { randomUUID } from 'crypto';
import { discordLogger as log } from '../../utils/logger.js';
import { chunkMessage } from '../../slack/message-formatter.js';
import { DISCORD_SAFE_CONTENT_LIMIT } from '../constants.js';
import type { ChannelManager } from '../channel-manager.js';
import type { AttachStore } from '../attach-store.js';
import type {
  ClaudeSdkEvents,
  ClaudeSdkToolResultInfo,
  ClaudeSdkTurnUsage,
} from './claude-sdk-session-manager.js';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type { DiscordState } from '../state.js';
import { SKIP_RESULT_TOOLS } from '../state.js';
import { tryRouteToAgent } from '../agent-routing.js';
import type { CodexSessionManager } from '../codex/codex-session-manager.js';
import type { AgentSessionManager } from '../agents/agent-session-manager.js';
import type { MemoryCollector } from '../../memory/memory-collector.js';
import { validateAttachmentPath } from '../utils.js';

interface ClaudeSdkHandlerContext {
  client: Client;
  channelManager: ChannelManager;
  state: DiscordState;
  attachStore?: AttachStore;
  codexSessionManager?: CodexSessionManager;
  agentSessionManagerRef?: { current: AgentSessionManager | undefined };
  memoryCollector?: MemoryCollector;
}

const ATTACH_MARKER_REGEX = /<attach>([^<]+)<\/attach>/g;
const MAX_ATTACH_BUTTONS = 5;

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


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function extractAttachMarkers(content: string): {
  cleanedContent: string;
  filePaths: string[];
  overflowCount: number;
} {
  const filePaths: string[] = [];
  let seen = 0;

  const cleanedContent = content
    .replace(ATTACH_MARKER_REGEX, (_, rawPath: string) => {
      const filePath = rawPath.trim();
      if (filePath && filePaths.length < MAX_ATTACH_BUTTONS) {
        filePaths.push(filePath);
      }
      seen += 1;
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    cleanedContent,
    filePaths,
    overflowCount: Math.max(0, seen - MAX_ATTACH_BUTTONS),
  };
}

async function sendAttachButtons(
  client: Client,
  thread: ThreadChannel,
  attachStore: AttachStore | undefined,
  sessionId: string,
  cwd: string | undefined,
  filePaths: string[],
) {
  if (!attachStore || !cwd || filePaths.length === 0) {
    return;
  }

  const buttons: Array<{
    customId: string;
    sessionId: string;
    threadId: string;
    filePath: string;
    cwd: string;
  }> = [];

  for (const filePath of filePaths) {
    const validation = validateAttachmentPath(filePath, cwd, { requireExists: true });
    if (!validation.ok) {
      log.warn({ sessionId, filePath, cwd, error: validation.error }, 'Skipping invalid attach marker');
      continue;
    }

    buttons.push({
      customId: `attach:${randomUUID()}`,
      sessionId,
      threadId: thread.id,
      filePath: validation.normalizedPath ?? filePath,
      cwd,
    });
  }

  if (buttons.length === 0) {
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...buttons.map(button =>
      new ButtonBuilder()
        .setCustomId(button.customId)
        .setLabel(`📎 ${basename(button.filePath)}`.slice(0, 80))
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  const message = await thread.send({
    content: '📎 **첨부 파일**\n클릭해서 받기',
    components: [row],
  });

  await attachStore.registerButtons(client, buttons.map(button => ({
    ...button,
    messageId: message.id,
  })));
}

export function createClaudeSdkHandlers(context: ClaudeSdkHandlerContext): ClaudeSdkEvents {
  const {
    attachStore,
    channelManager,
    client,
    codexSessionManager,
    memoryCollector,
    state,
  } = context;

  return {
    onSessionStart: async (sessionId, cwd, _discordThreadId, info) => {
      // Skip the "ready" card for lazy resumes after bot restart — the
      // resume notice posted by the lazy-resume path in discord-app.ts
      // already carries directory, model, session id, and tip line, so a
      // second message here is pure duplication. Fresh starts still get it.
      if (info?.isResume) return;

      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      try {
        await thread.send(
          `📡 **Claude SDK ready**\nDirectory: \`${cwd}\`\n` +
          `🧠 Memory collection active.  \`/memory opt-out\` to disable for this session.`,
        );
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

      if (thread) {
        try {
          await thread.send('🛑 **Claude SDK session ended**');
        } catch {
          // Ignore end notification failures.
        }
      }

      // Archive AFTER sending message (archiving then sending causes auto-unarchive)
      await channelManager.archiveSdkSession(sessionId);
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

      const mapping = channelManager.getSdkSession(sessionId);
      const {
        cleanedContent,
        filePaths,
        overflowCount,
      } = extractAttachMarkers(content);
      if (overflowCount > 0) {
        log.warn({ sessionId, overflowCount }, 'Too many attach markers; only first 5 were rendered');
      }

      const agents = channelManager.getAgentsInThread(thread.id);
      const multiAgent = !!(agents.codex || agents.agentAliases.size > 0);

      if (multiAgent) {
        const agentSessionManager = context.agentSessionManagerRef?.current;
        const resolveTarget = (targetName: string) => {
          if (targetName === 'codex' && agents.codex && codexSessionManager) {
            const codexSession = codexSessionManager.getSession(agents.codex);
            return {
              agent: 'codex',
              isAvailable: () => !!(codexSession && codexSession.status !== 'ended'),
              send: (msg: string) => codexSessionManager.sendInput(agents.codex!, msg),
            };
          }
          // Generic agent target
          const targetSessionId = agents.agentAliases.get(targetName);
          if (targetSessionId && agentSessionManager) {
            const targetSession = agentSessionManager.getSession(targetSessionId);
            return {
              agent: targetName,
              isAvailable: () => !!(targetSession && targetSession.status !== 'ended'),
              send: (msg: string) => agentSessionManager.sendInput(targetSessionId, msg),
            };
          }
          return null;
        };

        const { routed } = await tryRouteToAgent({
          thread,
          content: cleanedContent,
          agents,
          sourceAgent: 'claude',
          state,
          resolveTarget,
          isTargetAvailable: () => false,
          sendToTarget: () => false,
        });

        if (routed) {
          return;
        }
      }

      if (memoryCollector && cleanedContent.trim()) {
        const project = mapping?.cwd ? basename(mapping.cwd) : undefined;
        memoryCollector.onMessage({
          speaker: 'claude',
          displayName: 'Claude',
          content: cleanedContent,
          channelId: thread.id,
          threadId: thread.id,
          project,
        }).catch(err => log.error({ err }, 'Memory collect failed'));
      }

      log.info({ sessionId, threadId: thread.id, contentPreview: cleanedContent.slice(0, 50), pid: process.pid }, 'SDK onMessage: sending to Discord');

      const prefix = multiAgent ? '**Claude:** ' : '';
      const maxLen = DISCORD_SAFE_CONTENT_LIMIT - prefix.length;
      const chunks = cleanedContent ? chunkMessage(cleanedContent, maxLen) : [];

      for (const chunk of chunks) {
        await thread.send(`${prefix}${chunk}`);
      }

      await sendAttachButtons(client, thread, attachStore, sessionId, mapping?.cwd, filePaths);

      state.lastActiveAgent.set(thread.id, 'claude');
    },

    onToolCall: async (sessionId, info) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      log.info({ sessionId, toolName: info.toolName, inputKeys: info.input ? Object.keys(info.input as Record<string, unknown>) : [], threadId: thread.id, pid: process.pid }, 'SDK onToolCall');

      const input = info.input as Record<string, unknown> | null;
      let inputSummary = '';
      if (input) {
        if (info.toolName === 'Bash' && typeof input.command === 'string') {
          inputSummary = `\`${input.command.slice(0, 100)}${input.command.length > 100 ? '...' : ''}\``;
        } else if ((info.toolName === 'Read' || info.toolName === 'Edit' || info.toolName === 'Write') && typeof input.file_path === 'string') {
          inputSummary = `\`${input.file_path}\``;
        } else if ((info.toolName === 'Grep' || info.toolName === 'Glob') && typeof input.pattern === 'string') {
          inputSummary = `\`${input.pattern}\``;
        } else if (info.toolName === 'Skill') {
          const skillName = (input.skill as string) || '';
          const args = (input.args as string) || '';
          inputSummary = skillName ? `\`${skillName}\`${args ? ` ${args.slice(0, 80)}` : ''}` : '';
        } else if (info.toolName === 'Task' || info.toolName === 'Agent') {
          const agentType = input.subagent_type as string | undefined;
          const desc = (input.description as string) || (input.prompt as string)?.slice(0, 100) || '';
          inputSummary = agentType ? `\`[${agentType}]\` ${desc}` : desc;
          if (!inputSummary) {
            log.info({ toolName: info.toolName, inputKeys: Object.keys(input) }, 'Agent tool call with unknown input structure');
          }
        }
      }

      const toolLabel = (info.toolName === 'Task' || info.toolName === 'Agent') ? 'Agent' : info.toolName;
      const text = inputSummary
        ? `🔧 **${toolLabel}**: ${inputSummary}`
        : `🔧 **${toolLabel}**`;

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

    onAskUserQuestion: async (sessionId, requestId, questions) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) return;

      // Store pending question state (reuse PTY's pendingQuestions for button handlers)
      state.pendingQuestions.set(requestId, {
        sessionId,
        toolUseId: requestId,
        questions,
      });

      try {
        for (let qIdx = 0; qIdx < questions.length; qIdx++) {
          const q = questions[qIdx];
          const questionText = `❓ **${q.header}**\n${q.question}`;

          if (q.multiSelect) {
            const selectMenu = new StringSelectMenuBuilder()
              .setCustomId(`sdk_askq_select:${requestId}:${qIdx}`)
              .setPlaceholder('Select options...')
              .setMinValues(1)
              .setMaxValues(q.options.length);

            for (let oIdx = 0; oIdx < q.options.length; oIdx++) {
              const opt = q.options[oIdx];
              selectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                  .setLabel(opt.label.slice(0, 100))
                  .setDescription((opt.description || '').slice(0, 100) || opt.label.slice(0, 100))
                  .setValue(`${oIdx}`)
              );
            }

            const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
            const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`sdk_askq_submit:${requestId}:${qIdx}`)
                .setLabel('Submit')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`sdk_askq:${requestId}:${qIdx}:other`)
                .setLabel('Other...')
                .setStyle(ButtonStyle.Secondary)
            );

            await thread.send({ content: questionText, components: [selectRow, buttonRow] });
          } else {
            const optionsList = q.options
              .map((opt: { label: string; description: string }, idx: number) =>
                `${idx + 1}. **${opt.label}** - ${opt.description}`)
              .join('\n');
            const questionTextWithOptions = `${questionText}\n\n${optionsList}`;

            const rows: ActionRowBuilder<ButtonBuilder>[] = [];
            const currentRow = new ActionRowBuilder<ButtonBuilder>();

            for (let oIdx = 0; oIdx < q.options.length && oIdx < 4; oIdx++) {
              const opt = q.options[oIdx];
              currentRow.addComponents(
                new ButtonBuilder()
                  .setCustomId(`sdk_askq:${requestId}:${qIdx}:${oIdx}`)
                  .setLabel(opt.label.slice(0, 80))
                  .setStyle(ButtonStyle.Primary)
              );
            }

            currentRow.addComponents(
              new ButtonBuilder()
                .setCustomId(`sdk_askq:${requestId}:${qIdx}:other`)
                .setLabel('Other...')
                .setStyle(ButtonStyle.Secondary)
            );

            rows.push(currentRow);
            await thread.send({ content: questionTextWithOptions, components: rows });
          }
        }
      } catch (err) {
        log.error({ err }, 'Failed to post SDK AskUserQuestion');
      }
    },

    onSdkSessionIdUpdate: (sessionId, sdkSessionId) => {
      channelManager.setSdkSessionId(sessionId, sdkSessionId);
      log.info({ sessionId, sdkSessionId }, 'Persisted SDK session ID to channelManager');
    },

    onTurnComplete: async (sessionId, usage: ClaudeSdkTurnUsage) => {
      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) return;

      // inputTokens is already contextUsed (input + cacheRead + cacheCreation) from per-API-call usage
      const pct = usage.contextWindow > 0
        ? Math.round((usage.inputTokens / usage.contextWindow) * 100)
        : 0;

      const bar = pct >= 90 ? '🔴' : pct >= 70 ? '🟡' : '🟢';

      const line1 = [
        `${bar} **${pct}%** ctx`,
        ` (${formatTokens(usage.inputTokens)}/${formatTokens(usage.contextWindow)})`,
        ` · $${usage.totalCostUSD.toFixed(4)}`,
        ` · turn ${usage.numTurns}`,
      ].join('');

      // Per-model breakdown: "🤖 claude-opus-4-7: 28.4k · claude-haiku-4-5: 2.1k"
      // Sum tokens per model from the breakdown (already sorted by usage desc)
      let line2 = '';
      if (usage.models && usage.models.length > 0) {
        const parts = usage.models
          .map(m => {
            const total = m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
            return `${m.model}: ${formatTokens(total)}`;
          });
        line2 = `\n🤖 ${parts.join(' · ')}`;
      } else if (usage.model) {
        line2 = `\n🤖 ${usage.model}`;
      }

      try {
        await thread.send(line1 + line2);
      } catch { /* ignore */ }
    },

    onError: async (sessionId, error) => {
      const isAbort = error.message.includes('aborted') || error.message.includes('abort');
      const isInterrupt = error.message.includes('ede_diagnostic') || isAbort;

      if (isInterrupt) {
        log.info({ sessionId }, 'Claude SDK session interrupted');
      } else {
        log.error({ sessionId, error: error.message }, 'Claude SDK session error');
      }

      const interval = state.typingIntervals.get(`claude-sdk:${sessionId}`);
      if (interval) {
        clearInterval(interval);
        state.typingIntervals.delete(`claude-sdk:${sessionId}`);
      }

      const thread = await getClaudeSdkThread(client, channelManager, sessionId);
      if (!thread) {
        return;
      }

      if (isInterrupt) {
        await thread.send('🛑 **Interrupted** — 작업이 중단되었습니다.');
      } else {
        await thread.send(`❌ **Claude SDK Error:** ${error.message}`);
      }
    },
  };
}
