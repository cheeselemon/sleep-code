import {
  Client,
  GatewayIntentBits,
  Events,
  AttachmentBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  type Attachment,
} from 'discord.js';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import type { DiscordConfig } from './types.js';
import { SessionManager } from '../slack/session-manager.js';
import { ChannelManager } from './channel-manager.js';
import { chunkMessage, formatSessionStatus, formatTodos } from '../slack/message-formatter.js';
import { extractImagePaths } from '../utils/image-extractor.js';
import { discordLogger as log } from '../utils/logger.js';
import { ProcessManager, type ProcessEntry } from './process-manager.js';
import { SettingsManager } from './settings-manager.js';

// Prevent unhandled rejections from crashing the process
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled promise rejection');
});

// Image extensions that Claude can read
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/**
 * Download Discord attachment to temp directory
 */
async function downloadAttachment(attachment: Attachment): Promise<string | null> {
  const ext = attachment.name?.toLowerCase().split('.').pop() || '';
  if (!IMAGE_EXTENSIONS.includes(`.${ext}`)) {
    return null; // Not an image
  }

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      log.error({ status: response.status }, 'Failed to download attachment');
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const tempDir = join(tmpdir(), 'sleep-code-images');
    await mkdir(tempDir, { recursive: true });

    const filename = `${Date.now()}-${attachment.name || 'image.png'}`;
    const filepath = join(tempDir, filename);
    await writeFile(filepath, buffer);

    log.info({ filepath }, 'Downloaded image');
    return filepath;
  } catch (err) {
    log.error({ err }, 'Error downloading attachment');
    return null;
  }
}

/**
 * Check which terminal apps are installed (macOS)
 */
function getInstalledTerminals(): { terminal: boolean; iterm2: boolean } {
  return {
    terminal: existsSync('/System/Applications/Utilities/Terminal.app') ||
              existsSync('/Applications/Utilities/Terminal.app'),
    iterm2: existsSync('/Applications/iTerm.app'),
  };
}

export interface DiscordAppOptions {
  config: DiscordConfig;
  processManager?: ProcessManager;
  settingsManager?: SettingsManager;
}

export function createDiscordApp(config: DiscordConfig, options?: Partial<DiscordAppOptions>) {
  const processManager = options?.processManager;
  const settingsManager = options?.settingsManager;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const channelManager = new ChannelManager(client, config.userId);

  // Track messages sent from Discord to avoid re-posting
  const discordSentMessages = new Set<string>();

  // Track tool call messages for threading results
  const toolCallMessages = new Map<string, { messageId: string; toolName: string; filePath?: string }>(); // toolUseId -> info

  // Tools whose results should be skipped in Discord (too verbose)
  const SKIP_RESULT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Task']);

  // Track pending AskUserQuestion interactions
  interface PendingQuestion {
    sessionId: string;
    toolUseId: string;
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>;
  }
  const pendingQuestions = new Map<string, PendingQuestion>(); // toolUseId -> question data

  // Track multiSelect selections before submit
  const pendingMultiSelections = new Map<string, string[]>(); // `${toolUseId}:${qIdx}` -> selected option indices

  // Track answers for multi-question AskUserQuestion (accumulate until all answered)
  const pendingAnswers = new Map<string, string>(); // `${toolUseId}:${qIdx}` -> answer string

  // Track pending permission requests
  interface PendingPermission {
    requestId: string;
    sessionId: string;
    resolve: (decision: { behavior: 'allow' | 'deny'; message?: string }) => void;
  }
  const pendingPermissions = new Map<string, PendingPermission>(); // requestId -> resolver

  // Track pending titles for sessions that don't have threads yet
  const pendingTitles = new Map<string, string>(); // sessionId -> title

  // YOLO mode: auto-approve all permission requests for this session
  const yoloSessions = new Set<string>(); // sessionId

  // Typing indicator intervals for running sessions
  const typingIntervals = new Map<string, NodeJS.Timeout>(); // sessionId -> interval

  // Store full results for "View Full" button (with timestamp for cleanup)
  const pendingFullResults = new Map<string, { content: string; toolName: string; createdAt: number }>(); // resultId -> full content

  // Periodic cleanup of expired pendingFullResults (every 5 minutes)
  const FULL_RESULT_TTL = 30 * 60 * 1000; // 30 minutes
  const fullResultsCleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [resultId, data] of pendingFullResults) {
      if (now - data.createdAt > FULL_RESULT_TTL) {
        pendingFullResults.delete(resultId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.debug({ cleaned }, 'Cleaned expired pending full results');
    }
  }, 5 * 60 * 1000);

  // Helper to get thread for sending messages
  const getThread = async (sessionId: string) => {
    const session = channelManager.getSession(sessionId);
    if (!session) {
      log.debug({ sessionId }, 'getThread: No session mapping');
      return null;
    }
    try {
      const thread = await client.channels.fetch(session.threadId);
      if (thread?.isThread()) return thread;
      log.debug({ threadId: session.threadId }, 'getThread: Channel is not a thread');
    } catch (err) {
      log.debug({ threadId: session.threadId, err }, 'getThread: Failed to fetch thread');
    }
    return null;
  };

  // Helper to check if all questions are answered and submit
  const trySubmitAllAnswers = (toolUseId: string): boolean => {
    const pending = pendingQuestions.get(toolUseId);
    if (!pending) return false;

    const totalQuestions = pending.questions.length;
    const answers: Record<string, string> = {};

    // Check if all questions have answers
    for (let i = 0; i < totalQuestions; i++) {
      const answerKey = `${toolUseId}:${i}`;
      const answer = pendingAnswers.get(answerKey);
      if (!answer) {
        // Not all questions answered yet
        log.debug({ toolUseId, answered: i, total: totalQuestions }, 'Not all questions answered yet');
        return false;
      }
      answers[i.toString()] = answer;
    }

    // All questions answered, submit
    log.info({ toolUseId, answers }, 'All questions answered, submitting');
    sessionManager.allowPendingAskUserQuestion(pending.sessionId, answers);

    // Cleanup
    for (let i = 0; i < totalQuestions; i++) {
      pendingAnswers.delete(`${toolUseId}:${i}`);
      pendingMultiSelections.delete(`${toolUseId}:${i}`);
    }
    pendingQuestions.delete(toolUseId);

    return true;
  };

  // Create session manager with event handlers that post to Discord
  const sessionManager = new SessionManager({
    onSessionStart: async (session) => {
      // Notify ProcessManager that session connected (transitions 'starting' -> 'running')
      // Also track manually started sessions
      if (processManager) {
        const result = await processManager.onSessionConnected(session.id, session.cwd);

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

        const thread = await getThread(session.id);
        if (thread) {
          // Send session started message
          await thread.send(
            `${formatSessionStatus(session.status)} **Session started**\n\`${session.cwd}\`\nUse \`/panel\` for controls`
          );

          // Apply pending title if one was received before thread creation
          // Title updates disabled due to Discord rate limits
          const pendingTitle = pendingTitles.get(session.id);
          if (pendingTitle) {
            pendingTitles.delete(session.id);
          }
        }
      }
    },

    onSessionEnd: async (sessionId) => {
      // Clean up typing indicator to prevent resource leak
      const typingInterval = typingIntervals.get(sessionId);
      if (typingInterval) {
        clearInterval(typingInterval);
        typingIntervals.delete(sessionId);
      }

      // Update ProcessManager status
      if (processManager) {
        await processManager.updateStatus(sessionId, 'stopped');
      }

      const session = channelManager.getSession(sessionId);
      if (session) {
        const thread = await getThread(sessionId);
        if (thread) {
          await thread.send('🛑 **Session ended** - this thread will be archived');
        }

        await channelManager.archiveSession(sessionId);
      }
    },

    onSessionUpdate: async (sessionId, name) => {
      const session = channelManager.getSession(sessionId);
      if (session) {
        channelManager.updateName(sessionId, name);
        // Update thread name
        try {
          // Title updates disabled due to Discord rate limits
          // const thread = await getThread(sessionId);
          // if (thread) {
          //   const newName = `${session.sessionId} - ${name}`.slice(0, 100);
          //   await thread.setName(newName);
          // }
        } catch (err) {
          log.error({ err }, 'Failed to update thread name');
        }
      }
    },

    onSessionStatus: async (sessionId, status) => {
      const session = channelManager.getSession(sessionId);
      if (session) {
        channelManager.updateStatus(sessionId, status);

        // Manage typing indicator based on status
        if (status === 'running') {
          // Start typing indicator if not already running
          if (!typingIntervals.has(sessionId)) {
            const sendTyping = async () => {
              try {
                const thread = await getThread(sessionId);
                if (thread) {
                  await thread.sendTyping();
                }
              } catch {}
            };
            // Send immediately and then every 8 seconds
            sendTyping();
            const interval = setInterval(sendTyping, 8000);
            typingIntervals.set(sessionId, interval);
          }
        } else {
          // Stop typing indicator
          const interval = typingIntervals.get(sessionId);
          if (interval) {
            clearInterval(interval);
            typingIntervals.delete(sessionId);
          }
        }
      }
    },

    onTitleChange: async (sessionId, title) => {
      // Just store the title - will be applied when user sends a message
      pendingTitles.set(sessionId, title);
    },

    onMessage: async (sessionId, role, content) => {
      log.info({ sessionId, role, contentPreview: content.slice(0, 50) }, 'onMessage');
      const thread = await getThread(sessionId);
      if (!thread) {
        log.warn({ sessionId }, 'No thread found for session');
        return;
      }
      log.debug({ threadId: thread.id, sessionId }, 'Found thread for session');

      const formatted = content;

      if (role === 'user') {
        // Skip messages that originated from Discord
        const contentKey = content.trim();
        if (discordSentMessages.has(contentKey)) {
          discordSentMessages.delete(contentKey);
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
        const pendingTitle = pendingTitles.get(sessionId);
        if (pendingTitle) {
          pendingTitles.delete(sessionId);
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
    },

    onTodos: async (sessionId, todos) => {
      if (todos.length > 0) {
        const todosText = formatTodos(todos);
        try {
          const thread = await getThread(sessionId);
          if (thread) {
            await thread.send(`**Tasks:**\n${todosText}`);
          }
        } catch (err) {
          log.error({ err }, 'Failed to post todos');
        }
      }
    },

    onToolCall: async (sessionId, tool) => {
      log.info({ tool: tool.name, id: tool.id, inputPreview: JSON.stringify(tool.input).slice(0, 200) }, 'onToolCall');

      const thread = await getThread(sessionId);
      if (!thread) {
        log.debug({ sessionId }, 'No thread for session');
        return;
      }

      // Special handling for AskUserQuestion
      if (tool.name === 'AskUserQuestion' && tool.input.questions) {
        log.info({ count: tool.input.questions.length }, 'AskUserQuestion detected');
        try {
          // Store pending question for interaction handling
          pendingQuestions.set(tool.id, {
            sessionId,
            toolUseId: tool.id,
            questions: tool.input.questions,
          });

          // Build message with buttons/select menu for each question
          for (let qIdx = 0; qIdx < tool.input.questions.length; qIdx++) {
            const q = tool.input.questions[qIdx];
            const questionText = `❓ **${q.header}**\n${q.question}`;

            if (q.multiSelect) {
              // Use StringSelectMenu for multiSelect questions
              const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`askq_select:${tool.id}:${qIdx}`)
                .setPlaceholder('Select options...')
                .setMinValues(1)
                .setMaxValues(q.options.length);

              for (let oIdx = 0; oIdx < q.options.length; oIdx++) {
                const opt = q.options[oIdx];
                selectMenu.addOptions(
                  new StringSelectMenuOptionBuilder()
                    .setLabel(opt.label.slice(0, 100))
                    .setDescription(opt.description.slice(0, 100))
                    .setValue(`${oIdx}`)
                );
              }

              const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

              // Add Submit and Other buttons in a separate row
              const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`askq_submit:${tool.id}:${qIdx}`)
                  .setLabel('Submit')
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId(`askq:${tool.id}:${qIdx}:other`)
                  .setLabel('Other...')
                  .setStyle(ButtonStyle.Secondary)
              );

              await thread.send({
                content: questionText,
                components: [selectRow, buttonRow],
              });
            } else {
              // Use buttons for single-select questions (max 5 per row, max 4 options + Other)
              const rows: ActionRowBuilder<ButtonBuilder>[] = [];
              const currentRow = new ActionRowBuilder<ButtonBuilder>();

              for (let oIdx = 0; oIdx < q.options.length && oIdx < 4; oIdx++) {
                const opt = q.options[oIdx];
                const button = new ButtonBuilder()
                  .setCustomId(`askq:${tool.id}:${qIdx}:${oIdx}`)
                  .setLabel(opt.label.slice(0, 80))
                  .setStyle(ButtonStyle.Primary);

                currentRow.addComponents(button);
              }

              // Add "Other" button
              const otherButton = new ButtonBuilder()
                .setCustomId(`askq:${tool.id}:${qIdx}:other`)
                .setLabel('Other...')
                .setStyle(ButtonStyle.Secondary);
              currentRow.addComponents(otherButton);

              rows.push(currentRow);

              await thread.send({
                content: questionText,
                components: rows,
              });
            }
          }
        } catch (err) {
          log.error({ err }, 'Failed to post AskUserQuestion');
        }
        return;
      }

      // Format tool call summary
      let inputSummary = '';
      if (tool.name === 'Bash' && tool.input.command) {
        inputSummary = `\`${tool.input.command.slice(0, 100)}${tool.input.command.length > 100 ? '...' : ''}\``;
      } else if (tool.name === 'Read' && tool.input.file_path) {
        inputSummary = `\`${tool.input.file_path}\``;
      } else if (tool.name === 'Edit' && tool.input.file_path) {
        inputSummary = `\`${tool.input.file_path}\``;
      } else if (tool.name === 'Write' && tool.input.file_path) {
        inputSummary = `\`${tool.input.file_path}\``;
      } else if (tool.name === 'Grep' && tool.input.pattern) {
        inputSummary = `\`${tool.input.pattern}\``;
      } else if (tool.name === 'Glob' && tool.input.pattern) {
        inputSummary = `\`${tool.input.pattern}\``;
      } else if (tool.name === 'Task' && tool.input.description) {
        inputSummary = tool.input.description;
      }

      const text = inputSummary
        ? `🔧 **${tool.name}**: ${inputSummary}`
        : `🔧 **${tool.name}**`;

      try {
        const message = await thread.send(text);
        // Store the message id, tool name, and file path for Write tools
        const filePath = (tool.name === 'Write' || tool.name === 'Edit') ? tool.input.file_path : undefined;
        toolCallMessages.set(tool.id, { messageId: message.id, toolName: tool.name, filePath });
      } catch (err) {
        log.error({ err }, 'Failed to post tool call');
      }
    },

    onToolResult: async (sessionId, result) => {
      const toolInfo = toolCallMessages.get(result.toolUseId);
      toolCallMessages.delete(result.toolUseId);

      // Skip verbose tool results
      if (toolInfo && SKIP_RESULT_TOOLS.has(toolInfo.toolName)) {
        return;
      }

      const thread = await getThread(sessionId);
      if (!thread) return;

      // Upload file for Write/Edit tools on success
      if (toolInfo?.filePath && !result.isError && (toolInfo.toolName === 'Write' || toolInfo.toolName === 'Edit')) {
        try {
          const attachment = new AttachmentBuilder(toolInfo.filePath);
          await thread.send({
            content: `📄 **File ${toolInfo.toolName === 'Write' ? 'created' : 'edited'}**`,
            files: [attachment],
          });
          log.info({ filePath: toolInfo.filePath }, 'Uploaded file');
        } catch (err) {
          log.error({ err }, 'Failed to upload file');
        }
        return; // Skip text result for file operations
      }

      // Truncate long results
      const maxLen = 300;
      const fullContent = result.content;
      const isTruncated = fullContent.length > maxLen;
      let content = fullContent;
      if (isTruncated) {
        content = fullContent.slice(0, maxLen) + '\n... (truncated)';
      }

      const prefix = result.isError ? '❌ Error:' : '✅ Result:';
      const text = `${prefix}\n\`\`\`\n${content}\n\`\`\``;

      // Create "View Full" button if truncated
      let components: ActionRowBuilder<ButtonBuilder>[] = [];
      if (isTruncated) {
        const resultId = `${result.toolUseId}-${Date.now()}`;
        pendingFullResults.set(resultId, {
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
        // Cleanup is handled by periodic interval, not per-entry setTimeout
      }

      try {
        if (toolInfo?.messageId) {
          // Reply to the tool call message
          const parentMessage = await thread.messages.fetch(toolInfo.messageId);
          if (parentMessage) {
            await parentMessage.reply({ content: text, components });
          } else {
            await thread.send({ content: text, components });
          }
        } else {
          await thread.send({ content: text, components });
        }
      } catch (err) {
        log.error({ err }, 'Failed to post tool result');
      }
    },

    onPlanModeChange: async (sessionId, inPlanMode) => {
      const thread = await getThread(sessionId);
      if (!thread) return;

      const emoji = inPlanMode ? '📋' : '🔨';
      const status = inPlanMode ? 'Planning mode - Claude is designing a solution' : 'Execution mode - Claude is implementing';

      try {
        await thread.send(`${emoji} ${status}`);
      } catch (err) {
        log.error({ err }, 'Failed to post plan mode change');
      }
    },

    onPermissionRequest: (request) => {
      return new Promise((resolve) => {
        // YOLO mode: auto-approve without asking
        if (yoloSessions.has(request.sessionId)) {
          log.info({ tool: request.toolName }, 'YOLO mode: auto-approving');
          // Notify in thread
          getThread(request.sessionId).then(thread => {
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
        pendingPermissions.set(request.requestId, {
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
            const thread = await getThread(request.sessionId);
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
            pendingPermissions.delete(request.requestId);
          } catch (err) {
            log.error({ err }, 'Failed to post permission request');
            resolve({ behavior: 'deny', message: 'Failed to post to Discord' });
            pendingPermissions.delete(request.requestId);
          }
        };

        sendToThread();

        // No timeout - wait indefinitely for user response
      });
    },
  });

  // Handle messages in session channels (user sending input to Claude)
  client.on(Events.MessageCreate, async (message) => {
    // Ignore bot's own messages
    if (message.author.bot) return;

    // Ignore DMs
    if (!message.guild) return;

    const sessionId = channelManager.getSessionByChannel(message.channelId);
    if (!sessionId) return; // Not a session channel

    const channel = channelManager.getChannel(sessionId);
    if (!channel || channel.status === 'ended') {
      await message.reply('⚠️ This session has ended.');
      return;
    }

    log.info({ sessionId, contentPreview: message.content.slice(0, 50) }, 'Sending input to session');

    // React with checkmark to acknowledge receipt
    await message.react('✅').catch(() => {});

    // Download any image attachments
    const imagePaths: string[] = [];
    for (const [, attachment] of message.attachments) {
      const filepath = await downloadAttachment(attachment);
      if (filepath) {
        imagePaths.push(filepath);
      }
    }

    // Build message with image paths
    let inputText = message.content;
    if (imagePaths.length > 0) {
      const imageRefs = imagePaths.map(p => `[Image: ${p}]`).join('\n');
      inputText = inputText ? `${inputText}\n\n${imageRefs}` : imageRefs;
      log.info({ count: imagePaths.length }, 'Added images to message');
    }

    // Track this message so we don't re-post it
    discordSentMessages.add(inputText.trim());

    const sent = sessionManager.sendInput(sessionId, inputText);
    if (!sent) {
      discordSentMessages.delete(inputText.trim());
      await message.reply('⚠️ Failed to send input - session not connected.');
    }
  });

  // Handle Discord client errors to prevent crashes
  client.on('error', (err) => {
    log.error({ err }, 'Discord client error');
  });

  // When bot is ready
  client.once(Events.ClientReady, async (c) => {
    log.info({ tag: c.user.tag }, 'Logged in');
    await channelManager.initialize();

    // Register slash commands
    const commands = [
      new SlashCommandBuilder()
        .setName('background')
        .setDescription('Send Claude to background mode (Ctrl+B)'),
      new SlashCommandBuilder()
        .setName('interrupt')
        .setDescription('Interrupt Claude (Escape)'),
      new SlashCommandBuilder()
        .setName('mode')
        .setDescription('Toggle Claude mode (Shift+Tab)'),
      new SlashCommandBuilder()
        .setName('sessions')
        .setDescription('List active Claude Code sessions'),
      new SlashCommandBuilder()
        .setName('compact')
        .setDescription('Compact the conversation (/compact)'),
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('Switch Claude model')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Model name (opus, sonnet, haiku)')
            .setRequired(true)),
      new SlashCommandBuilder()
        .setName('yolo-sleep')
        .setDescription('Toggle YOLO mode - auto-approve all permission requests'),
      new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Show session control panel with Interrupt and YOLO buttons'),
      // Process management commands
      new SlashCommandBuilder()
        .setName('claude')
        .setDescription('Manage Claude Code sessions')
        .addSubcommand(sub =>
          sub.setName('start')
            .setDescription('Start a new Claude Code session'))
        .addSubcommand(sub =>
          sub.setName('stop')
            .setDescription('Stop a running Claude Code session'))
        .addSubcommand(sub =>
          sub.setName('status')
            .setDescription('Show all managed sessions'))
        .addSubcommand(sub =>
          sub.setName('add-dir')
            .setDescription('Add a directory to the whitelist')
            .addStringOption(opt =>
              opt.setName('path')
                .setDescription('Absolute directory path')
                .setRequired(true)))
        .addSubcommand(sub =>
          sub.setName('remove-dir')
            .setDescription('Remove a directory from the whitelist'))
        .addSubcommand(sub =>
          sub.setName('list-dirs')
            .setDescription('List all whitelisted directories'))
        .addSubcommand(sub =>
          sub.setName('set-terminal')
            .setDescription('Set terminal app for new sessions')),
    ];

    try {
      const rest = new REST({ version: '10' }).setToken(config.botToken);
      await rest.put(Routes.applicationCommands(c.user.id), {
        body: commands.map((cmd) => cmd.toJSON()),
      });
      log.info('Slash commands registered');
    } catch (err) {
      log.error({ err }, 'Failed to register slash commands');
    }
  });

  // Handle slash commands
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, channelId } = interaction;

    if (commandName === 'sessions') {
      const active = channelManager.getAllActive();
      if (active.length === 0) {
        await interaction.reply('No active sessions. Start a session with `sleep-code run -- claude`');
        return;
      }

      const text = active
        .map((s) => `<#${s.threadId}> (in <#${s.channelId}>) - ${formatSessionStatus(s.status)}`)
        .join('\n');

      await interaction.reply(`**Active Sessions:**\n${text}`);
      return;
    }

    if (commandName === 'background' || commandName === 'interrupt' || commandName === 'mode') {
      const sessionId = channelManager.getSessionByChannel(channelId);
      if (!sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }

      const channel = channelManager.getChannel(sessionId);
      if (!channel || channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended.');
        return;
      }

      // Send the appropriate escape sequence
      let key: string;
      let message: string;
      if (commandName === 'background') {
        key = '\x02'; // Ctrl+B
        message = '⬇️ Sent background command (Ctrl+B)';
      } else if (commandName === 'interrupt') {
        key = '\x1b'; // Escape
        message = '🛑 Sent interrupt (Escape)';
      } else {
        key = '\x1b[Z'; // Shift+Tab
        message = '🔄 Sent mode toggle (Shift+Tab)';
      }

      const sent = sessionManager.sendInput(sessionId, key);
      if (sent) {
        await interaction.reply(message);
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }

    if (commandName === 'compact') {
      const sessionId = channelManager.getSessionByChannel(channelId);
      if (!sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }

      const channel = channelManager.getChannel(sessionId);
      if (!channel || channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended.');
        return;
      }

      const sent = sessionManager.sendInput(sessionId, '/compact\n');
      if (sent) {
        await interaction.reply('🗜️ Sent /compact');
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }

    if (commandName === 'model') {
      const sessionId = channelManager.getSessionByChannel(channelId);
      if (!sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }

      const channel = channelManager.getChannel(sessionId);
      if (!channel || channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended.');
        return;
      }

      const modelArg = interaction.options.getString('name', true);
      const sent = sessionManager.sendInput(sessionId, `/model ${modelArg}\n`);
      if (sent) {
        await interaction.reply(`🧠 Sent /model ${modelArg}`);
      } else {
        await interaction.reply('⚠️ Failed to send command - session not connected.');
      }
    }

    if (commandName === 'yolo-sleep') {
      const sessionId = channelManager.getSessionByChannel(channelId);
      if (!sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }

      const channel = channelManager.getChannel(sessionId);
      if (!channel || channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended.');
        return;
      }

      // Toggle YOLO mode
      if (yoloSessions.has(sessionId)) {
        yoloSessions.delete(sessionId);
        await interaction.reply('🛡️ **YOLO mode OFF** - Permission requests will be shown');
      } else {
        yoloSessions.add(sessionId);
        await interaction.reply('🔥 **YOLO mode ON** - All permissions auto-approved!');
      }
    }

    if (commandName === 'panel') {
      const sessionId = channelManager.getSessionByChannel(channelId);
      if (!sessionId) {
        await interaction.reply('⚠️ This channel is not associated with an active session.');
        return;
      }

      const channel = channelManager.getChannel(sessionId);
      if (!channel || channel.status === 'ended') {
        await interaction.reply('⚠️ This session has ended.');
        return;
      }

      const isYolo = yoloSessions.has(sessionId);
      const controlButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`interrupt:${sessionId}`)
          .setLabel('🛑 Interrupt')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`yolo:${sessionId}`)
          .setLabel(isYolo ? '🔥 YOLO: ON' : '🛡️ YOLO: OFF')
          .setStyle(isYolo ? ButtonStyle.Success : ButtonStyle.Secondary)
      );

      await interaction.reply({
        content: '**Session Control Panel**',
        components: [controlButtons],
      });
    }

    // Handle /claude subcommands
    if (commandName === 'claude') {
      const subcommand = interaction.options.getSubcommand();

      // /claude start - show directory selection
      if (subcommand === 'start') {
        if (!processManager || !settingsManager) {
          await interaction.reply({ content: '⚠️ Process management not enabled.', ephemeral: true });
          return;
        }

        const dirs = settingsManager.getAllowedDirectories();
        if (dirs.length === 0) {
          await interaction.reply({
            content: '⚠️ No directories configured. Use `/claude add-dir` first.',
            ephemeral: true,
          });
          return;
        }

        // Create select menu for directories
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('claude_start_dir')
          .setPlaceholder('Select a directory...');

        for (const dir of dirs.slice(0, 25)) { // Discord limit: 25 options
          selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel(basename(dir))
              .setDescription(dir.slice(0, 100))
              .setValue(dir)
          );
        }

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        await interaction.reply({
          content: '📁 **Start Claude Session**\nSelect a directory:',
          components: [row],
          ephemeral: true,
        });
        return;
      }

      // /claude stop - show session selection
      if (subcommand === 'stop') {
        if (!processManager) {
          await interaction.reply({ content: '⚠️ Process management not enabled.', ephemeral: true });
          return;
        }

        const running = await processManager.getAllRunning();
        if (running.length === 0) {
          await interaction.reply({ content: '✅ No running sessions to stop.', ephemeral: true });
          return;
        }

        // Get current session if command is run from a session thread
        const currentSessionId = channelManager.getSessionByChannel(channelId);

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('claude_stop_session')
          .setPlaceholder('Select a session to stop...');

        for (const entry of running.slice(0, 25)) {
          const isCurrent = entry.sessionId === currentSessionId;
          const label = isCurrent
            ? `⭐ ${basename(entry.cwd)} (current)`
            : `${basename(entry.cwd)} (${entry.sessionId.slice(0, 8)})`;
          selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel(label.slice(0, 100))
              .setDescription(`PID ${entry.pid} - ${entry.status}`)
              .setValue(entry.sessionId)
          );
        }

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        await interaction.reply({
          content: '🛑 **Stop Claude Session**\nSelect a session:',
          components: [row],
          ephemeral: true,
        });
        return;
      }

      // /claude status - show all sessions
      if (subcommand === 'status') {
        if (!processManager) {
          await interaction.reply({ content: '⚠️ Process management not enabled.', ephemeral: true });
          return;
        }

        const entries = processManager.getAllEntries();
        if (entries.length === 0) {
          await interaction.reply({ content: '📋 No managed sessions.', ephemeral: true });
          return;
        }

        const statusEmoji: Record<string, string> = {
          starting: '🔄',
          running: '🟢',
          stopping: '🟡',
          stopped: '⚫',
          orphaned: '🔴',
        };

        const lines = entries.map(e => {
          const emoji = statusEmoji[e.status] || '❓';
          const age = Math.floor((Date.now() - new Date(e.startedAt).getTime()) / 60000);
          return `${emoji} **${basename(e.cwd)}** (${e.sessionId.slice(0, 8)})\n   PID: ${e.pid} | Status: ${e.status} | Age: ${age}m`;
        });

        const embed = new EmbedBuilder()
          .setTitle('📊 Claude Sessions')
          .setDescription(lines.join('\n\n'))
          .setColor(0x7289DA)
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      // /claude add-dir - add directory to whitelist
      if (subcommand === 'add-dir') {
        if (!settingsManager) {
          await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
          return;
        }

        const path = interaction.options.getString('path', true);
        const result = await settingsManager.addDirectory(path);

        if (result.success) {
          await interaction.reply({ content: `✅ Added \`${path}\` to whitelist.`, ephemeral: true });
        } else {
          await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        }
        return;
      }

      // /claude remove-dir - show directory selection for removal
      if (subcommand === 'remove-dir') {
        if (!settingsManager) {
          await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
          return;
        }

        const dirs = settingsManager.getAllowedDirectories();
        if (dirs.length === 0) {
          await interaction.reply({ content: '📁 No directories in whitelist.', ephemeral: true });
          return;
        }

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('claude_remove_dir')
          .setPlaceholder('Select a directory to remove...');

        for (const dir of dirs.slice(0, 25)) {
          selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel(basename(dir))
              .setDescription(dir.slice(0, 100))
              .setValue(dir)
          );
        }

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        await interaction.reply({
          content: '🗑️ **Remove Directory**\nSelect a directory to remove:',
          components: [row],
          ephemeral: true,
        });
        return;
      }

      // /claude list-dirs - list whitelisted directories
      if (subcommand === 'list-dirs') {
        if (!settingsManager) {
          await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
          return;
        }

        const dirs = settingsManager.getAllowedDirectories();
        if (dirs.length === 0) {
          await interaction.reply({
            content: '📁 **Whitelisted Directories**\nNo directories configured. Use `/claude add-dir` to add one.',
            ephemeral: true,
          });
          return;
        }

        const defaultDir = settingsManager.getDefaultDirectory();
        const lines = dirs.map(d => {
          const isDefault = d === defaultDir;
          return `• \`${d}\`${isDefault ? ' ⭐ (default)' : ''}`;
        });

        await interaction.reply({
          content: `📁 **Whitelisted Directories**\n${lines.join('\n')}`,
          ephemeral: true,
        });
        return;
      }

      // /claude set-terminal - set terminal app for new sessions
      if (subcommand === 'set-terminal') {
        if (!settingsManager) {
          await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
          return;
        }

        const installed = getInstalledTerminals();
        const currentApp = settingsManager.getTerminalApp();

        const currentLabel: Record<string, string> = {
          terminal: 'Terminal.app',
          iterm2: 'iTerm2',
          background: 'Background',
        };

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId('claude_set_terminal')
          .setPlaceholder('Select terminal app...');

        // Always add background option
        selectMenu.addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel('Background (no window)')
            .setDescription('Run in background without terminal window')
            .setValue('background')
            .setDefault(currentApp === 'background')
        );

        // Add Terminal.app if installed
        if (installed.terminal) {
          selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel('Terminal.app')
              .setDescription('macOS default terminal')
              .setValue('terminal')
              .setDefault(currentApp === 'terminal')
          );
        }

        // Add iTerm2 if installed
        if (installed.iterm2) {
          selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel('iTerm2')
              .setDescription('Popular third-party terminal')
              .setValue('iterm2')
              .setDefault(currentApp === 'iterm2')
          );
        }

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        await interaction.reply({
          content: `🖥️ **Terminal Settings**\nCurrent: **${currentLabel[currentApp]}**\n\nSelect where to open new sessions:`,
          components: [row],
          ephemeral: true,
        });
        return;
      }
    }
  });

  // Handle button interactions for AskUserQuestion
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // Handle button clicks
      if (interaction.isButton()) {
      const customId = interaction.customId;

      // Handle "View Full" button for truncated results
      if (customId.startsWith('fullresult:')) {
        const resultId = customId.slice('fullresult:'.length);
        const fullResult = pendingFullResults.get(resultId);

        if (!fullResult) {
          await interaction.reply({ content: '⚠️ This result has expired.', ephemeral: true });
          return;
        }

        // Create .txt file with full content
        const buffer = Buffer.from(fullResult.content, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, {
          name: `${fullResult.toolName}-result.txt`,
        });

        await interaction.reply({
          content: `📄 **Full result for ${fullResult.toolName}**`,
          files: [attachment],
        });

        // Clean up
        pendingFullResults.delete(resultId);

        // Remove button from original message
        try {
          await interaction.message.edit({ components: [] });
        } catch {}

        return;
      }

      // Handle interrupt button
      if (customId.startsWith('interrupt:')) {
        const sessionId = customId.slice('interrupt:'.length);
        const sent = sessionManager.sendInput(sessionId, '\x1b'); // Escape
        if (sent) {
          await interaction.reply({ content: '🛑 Interrupt sent', ephemeral: true });
        } else {
          await interaction.reply({ content: '⚠️ Session not found', ephemeral: true });
        }
        return;
      }

      // Handle YOLO toggle button
      if (customId.startsWith('yolo:')) {
        const sessionId = customId.slice('yolo:'.length);
        const isYolo = yoloSessions.has(sessionId);

        // Toggle state
        if (isYolo) {
          yoloSessions.delete(sessionId);
        } else {
          yoloSessions.add(sessionId);
        }
        const newState = !isYolo;

        // Update button label
        const updatedButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`interrupt:${sessionId}`)
            .setLabel('🛑 Interrupt')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`yolo:${sessionId}`)
            .setLabel(newState ? '🔥 YOLO: ON' : '🛡️ YOLO: OFF')
            .setStyle(newState ? ButtonStyle.Success : ButtonStyle.Secondary)
        );

        await interaction.update({ components: [updatedButton] });
        return;
      }

      // Handle permission request buttons
      if (customId.startsWith('perm:')) {
        // Immediately defer to prevent 3-second timeout
        await interaction.deferUpdate();

        const parts = customId.split(':');
        if (parts.length !== 3) return;

        const [, requestId, decision] = parts;
        const pending = pendingPermissions.get(requestId);
        if (!pending) {
          try {
            await interaction.editReply({ content: '⚠️ This permission request has expired.', components: [] });
          } catch (err) {
            log.warn({ err }, 'Failed to edit reply for expired permission');
          }
          return;
        }

        // 'allow' and 'yolo' both grant permission, 'deny' rejects
        const behavior = (decision === 'allow' || decision === 'yolo') ? 'allow' : 'deny';
        pending.resolve({ behavior });
        pendingPermissions.delete(requestId);

        let emoji: string;
        let statusText: string;
        if (decision === 'allow') {
          emoji = '✅';
          statusText = 'Permission granted';
        } else if (decision === 'yolo') {
          emoji = '🔥';
          statusText = 'Permission granted + YOLO mode ON';
          // Enable YOLO mode for this session
          yoloSessions.add(pending.sessionId);
        } else {
          emoji = '❌';
          statusText = 'Permission denied';
        }

        try {
          await interaction.editReply({
            content: `${emoji} ${statusText}`,
            components: [],
          });
        } catch (err) {
          log.warn({ err }, 'Failed to edit reply for permission (may have timed out)');
        }
        return;
      }

      // Handle multiSelect Submit button
      if (customId.startsWith('askq_submit:')) {
        const parts = customId.split(':');
        if (parts.length !== 3) return;

        const [, toolUseId, qIdxStr] = parts;
        const pending = pendingQuestions.get(toolUseId);
        if (!pending) {
          await interaction.reply({ content: '⚠️ This question has expired.', ephemeral: true });
          return;
        }

        const qIdx = parseInt(qIdxStr, 10);
        const question = pending.questions[qIdx];
        if (!question) {
          await interaction.reply({ content: '⚠️ Invalid question.', ephemeral: true });
          return;
        }

        // Get stored selections
        const selectionKey = `${toolUseId}:${qIdx}`;
        const selectedValues = pendingMultiSelections.get(selectionKey);
        if (!selectedValues || selectedValues.length === 0) {
          await interaction.reply({ content: '⚠️ Please select at least one option first.', ephemeral: true });
          return;
        }

        // Get selected option labels
        const selectedLabels = selectedValues.map((val) => {
          const optIdx = parseInt(val, 10);
          return question.options[optIdx]?.label || val;
        });

        // Store the answer
        const answerText = selectedLabels.join(', ');
        const answerKey = `${toolUseId}:${qIdx}`;
        pendingAnswers.set(answerKey, answerText);

        await interaction.update({
          content: `✅ **${question.header}**: ${answerText}`,
          components: [], // Remove all components
        });
        pendingMultiSelections.delete(selectionKey);

        // Try to submit if all questions answered
        trySubmitAllAnswers(toolUseId);
        return;
      }

      // Handle AskUserQuestion buttons
      if (!customId.startsWith('askq:')) return;

      const parts = customId.split(':');
      if (parts.length !== 4) return;

      const [, toolUseId, qIdxStr, optionPart] = parts;
      const pending = pendingQuestions.get(toolUseId);
      if (!pending) {
        await interaction.reply({ content: '⚠️ This question has expired.', ephemeral: true });
        return;
      }

      const qIdx = parseInt(qIdxStr, 10);
      const question = pending.questions[qIdx];
      if (!question) {
        await interaction.reply({ content: '⚠️ Invalid question.', ephemeral: true });
        return;
      }

      // Handle "Other" option - show modal
      if (optionPart === 'other') {
        const modal = new ModalBuilder()
          .setCustomId(`askq_modal:${toolUseId}:${qIdx}`)
          .setTitle(question.header.slice(0, 45));

        const textInput = new TextInputBuilder()
          .setCustomId('answer')
          .setLabel(question.question.slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter your answer...')
          .setRequired(true);

        const row = new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
        return;
      }

      // Handle option selection
      const optIdx = parseInt(optionPart, 10);
      const selectedOption = question.options[optIdx];
      if (!selectedOption) {
        await interaction.reply({ content: '⚠️ Invalid option.', ephemeral: true });
        return;
      }

      // Store the answer
      const answerKey = `${toolUseId}:${qIdx}`;
      pendingAnswers.set(answerKey, selectedOption.label);

      // Update this message to show selected answer
      await interaction.update({
        content: `✅ **${question.header}**: ${selectedOption.label}`,
        components: [], // Remove buttons
      });

      // Try to submit if all questions answered
      trySubmitAllAnswers(toolUseId);
    }

    // Handle StringSelectMenu interactions
    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;

      // Handle claude_start_dir selection
      if (customId === 'claude_start_dir') {
        if (!processManager || !settingsManager) {
          await interaction.reply({ content: '⚠️ Process management not enabled.', ephemeral: true });
          return;
        }

        const cwd = interaction.values[0];

        // Re-validate directory is still in whitelist (could have been removed since menu was shown)
        if (!settingsManager.isDirectoryAllowed(cwd)) {
          await interaction.update({
            content: `❌ Directory \`${cwd}\` is no longer in the whitelist.`,
            components: [],
          });
          return;
        }

        // Check maxConcurrentSessions limit
        const maxSessions = settingsManager.getMaxSessions();
        if (maxSessions !== undefined) {
          const running = await processManager.getAllRunning();
          if (running.length >= maxSessions) {
            await interaction.update({
              content: `❌ Maximum concurrent sessions limit reached (${maxSessions}). Stop a session first.`,
              components: [],
            });
            return;
          }
        }

        const sessionId = processManager.generateSessionId();

        try {
          await interaction.update({
            content: `🚀 Starting Claude session in \`${cwd}\`...`,
            components: [],
          });

          const terminalApp = settingsManager.getTerminalApp();
          const entry = await processManager.spawn(cwd, sessionId, terminalApp);
          log.info({ sessionId, cwd, pid: entry.pid, terminalApp }, 'Started Claude session via Discord');

          await interaction.followUp({
            content: `✅ **Session started**\nPID: ${entry.pid}\nSession: ${sessionId.slice(0, 8)}...\nDirectory: \`${cwd}\`\n\nWaiting for connection...`,
            ephemeral: true,
          });
        } catch (err) {
          log.error({ err, cwd }, 'Failed to start session');
          await interaction.followUp({
            content: `❌ Failed to start session: ${(err as Error).message}`,
            ephemeral: true,
          });
        }
        return;
      }

      // Handle claude_set_terminal selection
      if (customId === 'claude_set_terminal') {
        if (!settingsManager) {
          await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
          return;
        }

        const app = interaction.values[0] as 'terminal' | 'iterm2' | 'background';
        await settingsManager.setTerminalApp(app);

        const appNames: Record<string, string> = {
          terminal: 'Terminal.app',
          iterm2: 'iTerm2',
          background: 'Background (no window)',
        };

        // Add permission notice for terminal apps
        const permissionNotice = app !== 'background'
          ? `\n\n⚠️ **macOS will request permission on first run.**\nClick "Allow" to let AppleScript control ${appNames[app]}.`
          : '';

        await interaction.update({
          content: `✅ Terminal app set to **${appNames[app]}**\n\nNew sessions will open in ${app === 'background' ? 'the background' : 'a new terminal window'}.${permissionNotice}`,
          components: [],
        });
        return;
      }

      // Handle claude_stop_session selection
      if (customId === 'claude_stop_session') {
        if (!processManager) {
          await interaction.reply({ content: '⚠️ Process management not enabled.', ephemeral: true });
          return;
        }

        const sessionId = interaction.values[0];

        try {
          await interaction.update({
            content: `🛑 Stopping session ${sessionId.slice(0, 8)}...`,
            components: [],
          });

          const success = await processManager.kill(sessionId);
          if (success) {
            await interaction.followUp({
              content: `✅ Session ${sessionId.slice(0, 8)} stopped.`,
              ephemeral: true,
            });
          } else {
            await interaction.followUp({
              content: `❌ Failed to stop session.`,
              ephemeral: true,
            });
          }
        } catch (err) {
          log.error({ err, sessionId }, 'Failed to stop session');
          await interaction.followUp({
            content: `❌ Error: ${(err as Error).message}`,
            ephemeral: true,
          });
        }
        return;
      }

      // Handle claude_remove_dir selection
      if (customId === 'claude_remove_dir') {
        if (!settingsManager) {
          await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
          return;
        }

        const dir = interaction.values[0];
        const success = await settingsManager.removeDirectory(dir);

        await interaction.update({
          content: success
            ? `✅ Removed \`${dir}\` from whitelist.`
            : `❌ Failed to remove directory.`,
          components: [],
        });
        return;
      }

      // Handle multiSelect questions - store selection for later submit
      if (customId.startsWith('askq_select:')) {
        const parts = customId.split(':');
        if (parts.length !== 3) return;

        const [, toolUseId, qIdxStr] = parts;
        const pending = pendingQuestions.get(toolUseId);
        if (!pending) {
          await interaction.reply({ content: '⚠️ This question has expired.', ephemeral: true });
          return;
        }

        const qIdx = parseInt(qIdxStr, 10);
        const question = pending.questions[qIdx];
        if (!question) {
          await interaction.reply({ content: '⚠️ Invalid question.', ephemeral: true });
          return;
        }

        // Store selected values for later submit
        const selectionKey = `${toolUseId}:${qIdx}`;
        pendingMultiSelections.set(selectionKey, interaction.values);

        // Get selected option labels for display
        const selectedLabels = interaction.values.map((val) => {
          const optIdx = parseInt(val, 10);
          return question.options[optIdx]?.label || val;
        });

        // Update message to show current selection (don't submit yet)
        await interaction.update({
          content: `❓ **${question.header}**\n${question.question}\n\n✏️ Selected: ${selectedLabels.join(', ')}\n\n*Click Submit to confirm*`,
        });
        return;
      }
    }

    // Handle modal submissions
    if (interaction.isModalSubmit()) {
      const customId = interaction.customId;
      if (!customId.startsWith('askq_modal:')) return;

      const parts = customId.split(':');
      if (parts.length !== 3) return;

      const [, toolUseId, qIdxStr] = parts;
      const pending = pendingQuestions.get(toolUseId);
      if (!pending) {
        await interaction.reply({ content: '⚠️ This question has expired.', ephemeral: true });
        return;
      }

      const qIdx = parseInt(qIdxStr, 10);
      const question = pending.questions[qIdx];
      if (!question) {
        await interaction.reply({ content: '⚠️ Invalid question.', ephemeral: true });
        return;
      }

      const answer = interaction.fields.getTextInputValue('answer');

      // Store the answer
      const answerKey = `${toolUseId}:${qIdx}`;
      pendingAnswers.set(answerKey, answer);

      await interaction.reply({
        content: `✅ **${question.header}**: ${answer}`,
      });

      // Try to submit if all questions answered
      trySubmitAllAnswers(toolUseId);
    }
    } catch (err) {
      log.error({ err }, 'Error handling interaction');
    }
  });

  // Cleanup function for intervals
  const cleanup = () => {
    clearInterval(fullResultsCleanupInterval);
    // Clean up typing intervals
    for (const interval of typingIntervals.values()) {
      clearInterval(interval);
    }
    typingIntervals.clear();
  };

  return { client, sessionManager, channelManager, cleanup };
}
