/**
 * Discord app - main entry point
 *
 * Refactored to use separated modules:
 * - state.ts: Shared state management
 * - utils.ts: Utility functions
 * - commands/: Slash command handlers
 * - interactions/: Button/select menu/modal handlers
 * - handlers/: SessionManager callback handlers
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  MessageType,
  REST,
  Routes,
} from 'discord.js';
import type { DiscordConfig } from './types.js';
import { SessionManager } from '../slack/session-manager.js';
import { ChannelManager } from './channel-manager.js';
import { discordLogger as log } from '../utils/logger.js';
import type { ProcessManager } from './process-manager.js';
import type { SettingsManager } from './settings-manager.js';

// Import state management
import { createState, cleanupState } from './state.js';

// Import utils
import { downloadAttachment, downloadTextAttachment } from './utils.js';

// Import command handlers
import { commands, handleCommand } from './commands/index.js';
import type { CommandContext } from './commands/types.js';

// Import interaction handlers
import { handleButton, handleSelectMenu, handleModal } from './interactions/index.js';
import type { InteractionContext } from './interactions/types.js';

// Import session handlers
import { createSessionManagerEvents, type SessionManagerRef } from './handlers/index.js';

// Prevent unhandled rejections from crashing the process
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled promise rejection');
});

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
  const state = createState();

  // Create handler context
  const handlerContext = {
    client,
    channelManager,
    processManager,
    state,
  };

  // Create a ref for lazy sessionManager access (needed for circular dependency)
  const sessionManagerRef: SessionManagerRef = { current: null };

  // Create events with the ref (handlers will access sessionManager through ref.current)
  const events = createSessionManagerEvents(handlerContext, sessionManagerRef);

  // Now create SessionManager with the real events
  const sessionManager = new SessionManager(events);

  // Set the ref so handlers can access sessionManager
  sessionManagerRef.current = sessionManager;

  // Create command/interaction context
  const commandContext: CommandContext = {
    client,
    channelManager,
    sessionManager,
    processManager,
    settingsManager,
    state,
  };

  const interactionContext: InteractionContext = commandContext;

  // Handle messages in session channels (user sending input to Claude)
  client.on(Events.MessageCreate, async (message) => {
    // Ignore bot's own messages
    if (message.author.bot) return;

    // Ignore system messages (thread name changes, pins, etc.)
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;

    // Ignore DMs
    if (!message.guild) return;

    // Ignore messages in channels (only process thread messages)
    if (!message.channel.isThread()) return;

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
    const textContents: string[] = [];
    const errors: string[] = [];

    for (const [, attachment] of message.attachments) {
      // Try image first
      const filepath = await downloadAttachment(attachment);
      if (filepath) {
        imagePaths.push(filepath);
        continue;
      }

      // Try text file
      const textResult = await downloadTextAttachment(attachment);
      if (textResult) {
        if (textResult.success && textResult.content) {
          textContents.push(`[File: ${textResult.filename}]\n${textResult.content}`);
        } else if (textResult.error === 'size_exceeded') {
          const sizeKB = Math.round((textResult.size || 0) / 1024);
          errors.push(`\`${textResult.filename}\` is too large (${sizeKB}KB > 100KB limit)`);
        } else {
          errors.push(`Failed to download \`${textResult.filename}\``);
        }
      }
    }

    // Report errors if any
    if (errors.length > 0) {
      await message.reply(`⚠️ ${errors.join('\n')}`);
      if (textContents.length === 0 && imagePaths.length === 0 && !message.content.trim()) {
        return; // Nothing to send
      }
    }

    // Build message with attachments
    let inputText = message.content;
    if (imagePaths.length > 0) {
      const imageRefs = imagePaths.map(p => `[Image: ${p}]`).join('\n');
      inputText = inputText ? `${inputText}\n\n${imageRefs}` : imageRefs;
      log.info({ count: imagePaths.length }, 'Added images to message');
    }
    if (textContents.length > 0) {
      inputText = inputText ? `${inputText}\n\n${textContents.join('\n\n')}` : textContents.join('\n\n');
      log.info({ count: textContents.length }, 'Added text files to message');
    }

    // Track this message so we don't re-post it
    state.discordSentMessages.add(inputText.trim());

    const sent = sessionManager.sendInput(sessionId, inputText);
    if (!sent) {
      state.discordSentMessages.delete(inputText.trim());
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
    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, commandContext);
      } else if (interaction.isButton()) {
        await handleButton(interaction, interactionContext);
      } else if (interaction.isStringSelectMenu()) {
        await handleSelectMenu(interaction, interactionContext);
      } else if (interaction.isModalSubmit()) {
        await handleModal(interaction, interactionContext);
      }
    } catch (err) {
      log.error({ err }, 'Error handling interaction');
    }
  });

  // Cleanup function for intervals
  const cleanup = () => {
    cleanupState(state);
  };

  return { client, sessionManager, channelManager, cleanup };
}
