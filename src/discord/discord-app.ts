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
      console.error(`[Discord] Failed to download attachment: ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const tempDir = join(tmpdir(), 'sleep-code-images');
    await mkdir(tempDir, { recursive: true });

    const filename = `${Date.now()}-${attachment.name || 'image.png'}`;
    const filepath = join(tempDir, filename);
    await writeFile(filepath, buffer);

    console.log(`[Discord] Downloaded image to: ${filepath}`);
    return filepath;
  } catch (err) {
    console.error('[Discord] Error downloading attachment:', err);
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
  const toolCallMessages = new Map<string, string>(); // toolUseId -> message id

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

  // Helper to get thread for sending messages
  const getThread = async (sessionId: string) => {
    const session = channelManager.getSession(sessionId);
    if (!session) {
      console.log(`[Discord] getThread: No session mapping for ${sessionId}`);
      return null;
    }
    try {
      const thread = await client.channels.fetch(session.threadId);
      if (thread?.isThread()) return thread;
      console.log(`[Discord] getThread: Channel ${session.threadId} is not a thread`);
    } catch (err) {
      console.log(`[Discord] getThread: Failed to fetch thread ${session.threadId}:`, err);
    }
    return null;
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
          console.error('[Discord] Failed to update thread name:', err);
        }
      }
    },

    onSessionStatus: async (sessionId, status) => {
      const session = channelManager.getSession(sessionId);
      if (session) {
        channelManager.updateStatus(sessionId, status);
      }
    },

    onTitleChange: async (sessionId, title) => {
      // Just store the title - will be applied when user sends a message
      pendingTitles.set(sessionId, title);
    },

    onMessage: async (sessionId, role, content) => {
      console.log(`[Discord] onMessage: session=${sessionId}, role=${role}, content="${content.slice(0, 50)}..."`);
      const thread = await getThread(sessionId);
      if (!thread) {
        console.log(`[Discord] ❌ No thread found for session ${sessionId}`);
        return;
      }
      console.log(`[Discord] ✓ Found thread ${thread.id} for session ${sessionId}`);

      const formatted = content;

      if (role === 'user') {
        // Skip messages that originated from Discord
        const contentKey = content.trim();
        if (discordSentMessages.has(contentKey)) {
          discordSentMessages.delete(contentKey);
          console.log(`[Discord] Skipping Discord-originated message`);
          return;
        }

        // User message from terminal
        // Discord has 4000 char limit, leave room for "**User:** " prefix
        const chunks = chunkMessage(formatted, 3900);
        try {
          for (const chunk of chunks) {
            await thread.send(`**User:** ${chunk}`);
          }
          console.log(`[Discord] Sent user message to thread`);
        } catch (err: any) {
          console.error(`[Discord] ❌ Failed to send user message to thread ${thread.id}:`, err.message);
        }
      } else {
        // Title updates disabled due to Discord rate limits
        const pendingTitle = pendingTitles.get(sessionId);
        if (pendingTitle) {
          pendingTitles.delete(sessionId);
        }

        // Claude's response - Discord has 4000 char limit
        const chunks = chunkMessage(formatted, 3900);
        console.log(`[Discord] Sending ${chunks.length} chunks to thread`);
        try {
          for (const chunk of chunks) {
            await thread.send(chunk);
          }
          console.log(`[Discord] ✓ Sent assistant message`);
        } catch (err: any) {
          console.error(`[Discord] ❌ Failed to send assistant message to thread ${thread.id}:`, err.message);
        }

        // Extract and upload any images mentioned in the response
        const session = sessionManager.getSession(sessionId);
        const images = extractImagePaths(content, session?.cwd);
        for (const image of images) {
          try {
            console.log(`[Discord] Uploading image: ${image.resolvedPath}`);
            const attachment = new AttachmentBuilder(image.resolvedPath);
            await thread.send({
              content: `📎 ${image.originalPath}`,
              files: [attachment],
            });
          } catch (err) {
            console.error('[Discord] Failed to upload image:', err);
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
          console.error('[Discord] Failed to post todos:', err);
        }
      }
    },

    onToolCall: async (sessionId, tool) => {
      console.log(`[Discord] onToolCall: ${tool.name}, id=${tool.id}, input=${JSON.stringify(tool.input).slice(0, 200)}`);

      const thread = await getThread(sessionId);
      if (!thread) {
        console.log(`[Discord] No thread for session ${sessionId}`);
        return;
      }

      // Special handling for AskUserQuestion
      if (tool.name === 'AskUserQuestion' && tool.input.questions) {
        console.log(`[Discord] AskUserQuestion detected with ${tool.input.questions.length} questions`);
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
          console.error('[Discord] Failed to post AskUserQuestion:', err);
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
        // Store the message id for threading results (sub-thread in thread)
        toolCallMessages.set(tool.id, message.id);
      } catch (err) {
        console.error('[Discord] Failed to post tool call:', err);
      }
    },

    onToolResult: async (sessionId, result) => {
      const thread = await getThread(sessionId);
      if (!thread) return;

      const parentMessageId = toolCallMessages.get(result.toolUseId);

      // Truncate long results
      const maxLen = 1800;
      let content = result.content;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen) + '\n... (truncated)';
      }

      const prefix = result.isError ? '❌ Error:' : '✅ Result:';
      const text = `${prefix}\n\`\`\`\n${content}\n\`\`\``;

      try {
        if (parentMessageId) {
          // Reply to the tool call message
          const parentMessage = await thread.messages.fetch(parentMessageId);
          if (parentMessage) {
            await parentMessage.reply(text);
          } else {
            await thread.send(text);
          }
        } else {
          await thread.send(text);
        }

        toolCallMessages.delete(result.toolUseId);
      } catch (err) {
        console.error('[Discord] Failed to post tool result:', err);
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
        console.error('[Discord] Failed to post plan mode change:', err);
      }
    },

    onPermissionRequest: (request) => {
      return new Promise((resolve) => {
        // YOLO mode: auto-approve without asking
        if (yoloSessions.has(request.sessionId)) {
          console.log(`[Discord] YOLO mode: auto-approving ${request.toolName}`);
          // Notify in thread
          getThread(request.sessionId).then(thread => {
            if (thread) {
              thread.send(`🔥 **YOLO**: Auto-approved \`${request.toolName}\``)
                .then(() => console.log(`[Discord] YOLO notification sent`))
                .catch((err) => console.error(`[Discord] YOLO notification failed:`, err.message));
            } else {
              console.log(`[Discord] YOLO: No thread found for session ${request.sessionId}`);
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

            // Fallback to first active session's thread
            console.log('[Discord] No thread found for permission request, using first active session');
            const active = channelManager.getAllActive();
            if (active.length > 0) {
              const fallbackThread = await client.channels.fetch(active[0].threadId);
              if (fallbackThread?.isThread()) {
                await fallbackThread.send({ content: text, components: [row] });
                return;
              }
            }

            // No thread available, auto-deny
            console.log('[Discord] No active threads, auto-denying permission');
            resolve({ behavior: 'deny', message: 'No Discord thread available' });
            pendingPermissions.delete(request.requestId);
          } catch (err) {
            console.error('[Discord] Failed to post permission request:', err);
            resolve({ behavior: 'deny', message: 'Failed to post to Discord' });
            pendingPermissions.delete(request.requestId);
          }
        };

        sendToThread();

        // Timeout after 5 minutes
        const TIMEOUT_MS = 5 * 60 * 1000;
        setTimeout(() => {
          if (pendingPermissions.has(request.requestId)) {
            console.log(`[Discord] Permission request ${request.requestId} timed out`);
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

    console.log(`[Discord] Sending input to session ${sessionId}: ${message.content.slice(0, 50)}...`);

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
      console.log(`[Discord] Added ${imagePaths.length} image(s) to message`);
    }

    // Track this message so we don't re-post it
    discordSentMessages.add(inputText.trim());

    const sent = sessionManager.sendInput(sessionId, inputText);
    if (!sent) {
      discordSentMessages.delete(inputText.trim());
      await message.reply('⚠️ Failed to send input - session not connected.');
    }
  });

  // When bot is ready
  client.once(Events.ClientReady, async (c) => {
    console.log(`[Discord] Logged in as ${c.user.tag}`);
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
      console.log('[Discord] Slash commands registered');
    } catch (err) {
      console.error('[Discord] Failed to register slash commands:', err);
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
    // Handle button clicks
    if (interaction.isButton()) {
      const customId = interaction.customId;

      // Handle permission request buttons
      if (customId.startsWith('perm:')) {
        const parts = customId.split(':');
        if (parts.length !== 3) return;

        const [, requestId, decision] = parts;
        const pending = pendingPermissions.get(requestId);
        if (!pending) {
          await interaction.reply({ content: '⚠️ This permission request has expired.', ephemeral: true });
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

        await interaction.update({
          content: `${emoji} ${statusText}`,
          components: [],
        });
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

        // Allow pending permission with the answers
        const answerText = selectedLabels.join(', ');
        const answers: Record<string, string> = { [qIdx.toString()]: answerText };
        sessionManager.allowPendingAskUserQuestion(pending.sessionId, answers);

        await interaction.update({
          content: `✅ **${question.header}**: ${answerText}`,
          components: [], // Remove all components
        });
        pendingQuestions.delete(toolUseId);
        pendingMultiSelections.delete(selectionKey);
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

      // Allow pending permission with the answer
      const answers: Record<string, string> = { [qIdx.toString()]: selectedOption.label };
      sessionManager.allowPendingAskUserQuestion(pending.sessionId, answers);

      await interaction.update({
        content: `✅ **${question.header}**: ${selectedOption.label}`,
        components: [], // Remove buttons
      });
      pendingQuestions.delete(toolUseId);
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

      // Allow pending permission with the answer
      const answers: Record<string, string> = { [qIdx.toString()]: answer };
      sessionManager.allowPendingAskUserQuestion(pending.sessionId, answers);

      await interaction.reply({
        content: `✅ **${question.header}**: ${answer}`,
      });
      pendingQuestions.delete(toolUseId);
    }
  });

  return { client, sessionManager, channelManager };
}
