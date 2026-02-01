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
  type Attachment,
} from 'discord.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { DiscordConfig } from './types.js';
import { SessionManager } from '../slack/session-manager.js';
import { ChannelManager } from './channel-manager.js';
import { chunkMessage, formatSessionStatus, formatTodos } from '../slack/message-formatter.js';
import { extractImagePaths } from '../utils/image-extractor.js';
import { discordLogger as log } from '../utils/logger.js';

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

export function createDiscordApp(config: DiscordConfig) {
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
    resolve: (decision: { behavior: 'allow' | 'deny'; message?: string }) => void;
  }
  const pendingPermissions = new Map<string, PendingPermission>(); // requestId -> resolver

  // Track pending titles for sessions that don't have threads yet
  const pendingTitles = new Map<string, string>(); // sessionId -> title

  // YOLO mode: auto-approve all permission requests for this session
  const yoloSessions = new Set<string>(); // sessionId

  // Typing indicator intervals for running sessions
  const typingIntervals = new Map<string, NodeJS.Timeout>(); // sessionId -> interval

  // Store full results for "View Full" button
  const pendingFullResults = new Map<string, { content: string; toolName: string }>(); // resultId -> full content

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
      const mapping = await channelManager.createSession(session.id, session.name, session.cwd);
      if (mapping) {
        const thread = await getThread(session.id);
        if (thread) {
          await thread.send(
            `${formatSessionStatus(session.status)} **Session started**\n\`${session.cwd}\``
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
        pendingFullResults.set(resultId, { content: fullContent, toolName: toolInfo?.toolName || 'unknown' });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`fullresult:${resultId}`)
            .setLabel('View Full')
            .setStyle(ButtonStyle.Secondary)
        );
        components = [row];

        // Auto-expire after 30 minutes
        setTimeout(() => pendingFullResults.delete(resultId), 30 * 60 * 1000);
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

        // Create buttons: Allow, Always Allow, Deny
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`perm:${request.requestId}:allow`)
            .setLabel('Allow')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`perm:${request.requestId}:always`)
            .setLabel('Always Allow')
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

            // Fallback 1: first active session's thread
            log.warn('No thread found for permission request, trying active sessions');
            const active = channelManager.getAllActive();
            if (active.length > 0) {
              const fallbackThread = await client.channels.fetch(active[0].threadId);
              if (fallbackThread?.isThread()) {
                await fallbackThread.send({ content: text, components: [row] });
                return;
              }
            }

            // Fallback 2: persisted mappings (after PM2 restart)
            log.warn('No active sessions, trying persisted mappings');
            const persisted = channelManager.getPersistedMapping(request.sessionId)
              || channelManager.getAllPersisted()[0];
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

        // Timeout after 5 minutes
        const TIMEOUT_MS = 5 * 60 * 1000;
        setTimeout(() => {
          if (pendingPermissions.has(request.requestId)) {
            log.warn({ requestId: request.requestId }, 'Permission request timed out');
            resolve({ behavior: 'deny', message: 'Request timed out' });
            pendingPermissions.delete(request.requestId);
          }
        }, TIMEOUT_MS);
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

        // 'allow' and 'always' both grant permission, 'deny' rejects
        const behavior = (decision === 'allow' || decision === 'always') ? 'allow' : 'deny';
        pending.resolve({ behavior });
        pendingPermissions.delete(requestId);

        let emoji: string;
        let statusText: string;
        if (decision === 'allow') {
          emoji = '✅';
          statusText = 'Permission granted';
        } else if (decision === 'always') {
          emoji = '✅';
          statusText = 'Permission granted (always allow)';
          // TODO: Add to Claude Code's settings.json for persistent permission
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

    // Handle StringSelectMenu interactions for multiSelect questions - store selection for later submit
    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;
      if (!customId.startsWith('askq_select:')) return;

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

  return { client, sessionManager, channelManager };
}
