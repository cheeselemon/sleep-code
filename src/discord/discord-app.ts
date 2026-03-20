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
import { CodexSessionManager } from './codex/codex-session-manager.js';
import { createCodexEvents } from './codex/codex-handlers.js';
import { CODEX_MODEL } from './codex/codex-session-manager.js';
import { ClaudeSdkSessionManager } from './claude-sdk/claude-sdk-session-manager.js';
import { createClaudeSdkHandlers } from './claude-sdk/claude-sdk-handlers.js';

// Import state management
import { createState, cleanupState } from './state.js';

// Import utils
import { downloadAttachment, downloadTextAttachment, parseRoutingDirective } from './utils.js';
import { basename } from 'path';
import { randomUUID } from 'crypto';

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

import type { MemoryCollector } from '../memory/memory-collector.js';

export interface DiscordAppOptions {
  config: DiscordConfig;
  processManager?: ProcessManager;
  settingsManager?: SettingsManager;
  enableCodex?: boolean;
  memoryCollector?: MemoryCollector;
}

export function createDiscordApp(config: DiscordConfig, options?: Partial<DiscordAppOptions>) {
  const processManager = options?.processManager;
  const settingsManager = options?.settingsManager;
  const enableCodex = options?.enableCodex ?? false;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const channelManager = new ChannelManager(client, config.userId);
  const state = createState();

  // Create a ref for lazy sessionManager access (needed for circular dependency)
  const sessionManagerRef: SessionManagerRef = { current: null };
  const claudeSdkSessionManagerRef: { current: ClaudeSdkSessionManager | undefined } = { current: undefined };

  // Initialize Codex session manager if enabled
  let codexSessionManager: CodexSessionManager | undefined;
  if (enableCodex) {
    const codexEvents = createCodexEvents({
      client,
      channelManager,
      state,
      sessionManagerRef,
      claudeSdkSessionManagerRef,
      memoryCollector: options?.memoryCollector,
    });
    codexSessionManager = new CodexSessionManager(codexEvents, {
      onCodexThreadIdSet: (sessionId, codexThreadId) => {
        channelManager.setCodexThreadId(sessionId, codexThreadId);
      },
    });
    log.info('Codex session manager initialized');
  }

  const claudeSdkEvents = createClaudeSdkHandlers({
    client,
    channelManager,
    state,
    codexSessionManager,
    memoryCollector: options?.memoryCollector,
  });
  const claudeSdkSessionManager = new ClaudeSdkSessionManager(claudeSdkEvents, state);
  claudeSdkSessionManagerRef.current = claudeSdkSessionManager;
  log.info('Claude SDK session manager initialized');

  // Create handler context
  const handlerContext = {
    client,
    channelManager,
    processManager,
    codexSessionManager,
    claudeSdkSessionManager,
    state,
    memoryCollector: options?.memoryCollector,
  };

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
    codexSessionManager,
    claudeSdkSessionManager,
    state,
  };

  const interactionContext: InteractionContext = commandContext;

  // Handle messages in session channels (user sending input to Claude or Codex)
  client.on(Events.MessageCreate, async (message) => {
    // Ignore bot's own messages
    if (message.author.bot) return;

    // Ignore system messages (thread name changes, pins, etc.)
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;

    // Ignore DMs
    if (!message.guild) return;

    // Ignore messages in channels (only process thread messages)
    if (!message.channel.isThread()) return;

    const threadId = message.channelId;

    // Check which agents are active in this thread
    const agents = channelManager.getAgentsInThread(threadId);
    const claudeSessionId = agents.claude;
    const codexSessionId = agents.codex;

    // Not a session thread
    if (!claudeSessionId && !codexSessionId) return;

    // Parse routing from raw user text (before attachment merging)
    const directive = parseRoutingDirective(message.content, {
      hasClaude: !!claudeSessionId,
      hasCodex: !!codexSessionId,
      lastActive: state.lastActiveAgent.get(threadId),
    });
    const { target, cleanContent, invalidMention } = directive;

    log.info({ threadId, target, explicit: directive.explicit, contentPreview: cleanContent.slice(0, 50) }, 'Routing message');

    // Warn if @mention is in body but not at the start (multi-agent only)
    if (invalidMention && claudeSessionId && codexSessionId) {
      await message.reply('💡 `@codex`/`@claude` must be the **first word** of your message to route it. Your message was sent to the default agent.').catch(() => {});
    }

    // Reset agent-to-agent routing counter on user message
    state.agentRoutingCount.set(threadId, 0);

    // React with checkmark to acknowledge receipt
    await message.react('✅').catch(() => {});

    // Collect user message for memory
    if (handlerContext.memoryCollector && cleanContent.trim()) {
      const claudeMapping = claudeSessionId
        ? channelManager.getSession(claudeSessionId) ?? channelManager.getSdkSession(claudeSessionId)
        : undefined;
      const sessionCwd = claudeMapping?.cwd;
      handlerContext.memoryCollector.onMessage({
        speaker: 'user',
        displayName: message.member?.displayName ?? message.author.username,
        content: cleanContent,
        channelId: message.channel.parentId ?? message.channelId,
        threadId: message.channelId,
        project: sessionCwd ? basename(sessionCwd) : undefined,
      }).catch(err => log.error({ err }, 'Memory collect failed'));
    }

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
      if (textContents.length === 0 && imagePaths.length === 0 && !cleanContent.trim()) {
        return; // Nothing to send
      }
    }

    // Prefix with Discord display name so agents can identify the human speaker
    const displayName = message.member?.displayName ?? message.author.displayName ?? message.author.username;

    // Build message with attachments
    let inputText = cleanContent;
    if (imagePaths.length > 0) {
      const imageRefs = imagePaths.map(p => `[Image: ${p}]`).join('\n');
      inputText = inputText ? `${inputText}\n\n${imageRefs}` : imageRefs;
      log.info({ count: imagePaths.length }, 'Added images to message');
    }
    if (textContents.length > 0) {
      inputText = inputText ? `${inputText}\n\n${textContents.join('\n\n')}` : textContents.join('\n\n');
      log.info({ count: textContents.length }, 'Added text files to message');
    }

    // Route to the correct agent
    if (target === 'codex') {
      if (!codexSessionManager) {
        await message.reply('⚠️ Codex is not enabled.');
        return;
      }

      // Auto-create Codex session if not in thread yet
      let effectiveCodexSessionId = codexSessionId;
      if (!effectiveCodexSessionId) {
        // Get CWD from the existing Claude session
        const claudeMapping = claudeSessionId
          ? channelManager.getSession(claudeSessionId) ?? channelManager.getSdkSession(claudeSessionId)
          : null;
        if (!claudeMapping) {
          await message.reply('⚠️ Cannot determine working directory for Codex.');
          return;
        }

        try {
          const mapping = await channelManager.createCodexSession('pending', 'codex-auto', claudeMapping.cwd, threadId);
          if (!mapping) {
            await message.reply('⚠️ Failed to create Codex session.');
            return;
          }
          const isYolo = claudeSessionId ? state.yoloSessions.has(claudeSessionId) : false;
          const entry = await codexSessionManager.startSession(claudeMapping.cwd, threadId, {
            sandboxMode: isYolo ? 'workspace-write' : 'read-only',
          });
          channelManager.updateCodexSessionId('pending', entry.id);
          effectiveCodexSessionId = entry.id;
          log.info({ sessionId: entry.id, cwd: claudeMapping.cwd, sandboxMode: isYolo ? 'workspace-write' : 'read-only' }, 'Auto-created Codex session in existing thread');

          // Notify Discord thread only — no PTY injection to avoid prompt injection suspicion
          // Claude learns about Codex via CLAUDE.md protocol (set up with /setup-multi-agent)
          try {
            await message.channel.send(`**Codex joined this thread.** Model: \`${CODEX_MODEL}\`. Messages are prefixed with agent names.`);
          } catch { /* ignore */ }
        } catch (err) {
          log.error({ err }, 'Failed to auto-create Codex session');
          await message.reply(`⚠️ Failed to start Codex: ${(err as Error).message}`);
          return;
        }
      }

      const codexInput = `${displayName}: ${inputText}`;
      const sent = await codexSessionManager.sendInput(effectiveCodexSessionId, codexInput);
      if (!sent) {
        await message.reply('⚠️ Failed to send input to Codex - session busy or ended.');
      }
      state.lastActiveAgent.set(threadId, 'codex');
    } else {
      // Route to Claude
      let effectiveClaudeSessionId = claudeSessionId;

      // Auto-create Claude SDK session if @claude mentioned but no session exists
      if (!effectiveClaudeSessionId) {
        // Get CWD from the existing Codex session
        const codexEntry = codexSessionId
          ? codexSessionManager?.getSession(codexSessionId)
          : null;
        if (!codexEntry) {
          await message.reply('⚠️ No Claude session in this thread. Use `/claude start` or `/claude start-sdk` first.');
          return;
        }

        try {
          const sdkSessionId = randomUUID();
          const sessionName = `claude-sdk-auto`;
          const mapping = await channelManager.createSdkSession(sdkSessionId, sessionName, codexEntry.cwd, threadId);
          if (!mapping) {
            await message.reply('⚠️ Failed to create Claude SDK session.');
            return;
          }

          const entry = await claudeSdkSessionManager.startSession(codexEntry.cwd, mapping.threadId, {
            sessionId: sdkSessionId,
          });
          channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);
          effectiveClaudeSessionId = entry.id;
          log.info({ sessionId: entry.id, cwd: codexEntry.cwd }, 'Auto-created Claude SDK session in existing thread');

          try {
            await message.channel.send('**Claude joined this thread (SDK mode).** Messages are prefixed with agent names.');
          } catch { /* ignore */ }
        } catch (err) {
          log.error({ err }, 'Failed to auto-create Claude SDK session');
          await message.reply(`⚠️ Failed to start Claude SDK: ${(err as Error).message}`);
          return;
        }
      }

      let sdkSession = claudeSdkSessionManager.getSession(effectiveClaudeSessionId);

      // Lazy Resume: mapping exists but no active SDK process (e.g. after bot restart)
      if (!sdkSession || sdkSession.status === 'ended') {
        const persisted = channelManager.getPersistedSdkMappings().find(m => m.sessionId === effectiveClaudeSessionId);
        if (persisted) {
          // If sdkSessionId was never properly updated (equals internal sessionId),
          // skip resume and go straight to fresh start
          const canResume = persisted.sdkSessionId && persisted.sdkSessionId !== persisted.sessionId;

          if (canResume) {
            log.info({ sessionId: effectiveClaudeSessionId, sdkSessionId: persisted.sdkSessionId, cwd: persisted.cwd }, 'Lazy-resuming SDK session after bot restart');
            try {
              const entry = await claudeSdkSessionManager.startSession(persisted.cwd, persisted.threadId!, {
                sessionId: persisted.sessionId,
                resume: persisted.sdkSessionId,
              });
              channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);
              sdkSession = entry;
            } catch (resumeErr) {
              log.warn({ err: resumeErr, sessionId: effectiveClaudeSessionId }, 'Lazy resume failed, trying fresh start');
              try {
                const entry = await claudeSdkSessionManager.startSession(persisted.cwd, persisted.threadId!, {
                  sessionId: persisted.sessionId,
                });
                channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);
                sdkSession = entry;
              } catch (freshErr) {
                log.error({ err: freshErr, sessionId: effectiveClaudeSessionId }, 'Fresh start also failed');
                await message.reply('⚠️ Failed to resume Claude session. Use `/claude start-sdk` to start a new one.');
                return;
              }
            }
          } else {
            log.warn({ sessionId: effectiveClaudeSessionId }, 'Skipping resume: sdkSessionId is corrupted (equals sessionId), starting fresh');
            try {
              const entry = await claudeSdkSessionManager.startSession(persisted.cwd, persisted.threadId!, {
                sessionId: persisted.sessionId,
              });
              channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);
              sdkSession = entry;
            } catch (freshErr) {
              log.error({ err: freshErr, sessionId: effectiveClaudeSessionId }, 'Fresh start failed');
              await message.reply('⚠️ Failed to start Claude session. Use `/claude start-sdk` to start a new one.');
              return;
            }
          }
        }
      }

      if (sdkSession && sdkSession.status !== 'ended') {
        const claudeInput = `${displayName}: ${inputText}`;
        const sent = claudeSdkSessionManager.sendInput(effectiveClaudeSessionId, claudeInput);
        if (!sent) {
          await message.reply('⚠️ Failed to send input to Claude SDK - session busy or ended.');
          return;
        }

        state.lastActiveAgent.set(threadId, 'claude');
        return;
      }

      const channel = channelManager.getSession(effectiveClaudeSessionId);
      if (!channel || channel.status === 'ended') {
        await message.reply('⚠️ This Claude session has ended.');
        return;
      }

      // Track this message so we don't re-post it
      const claudeInput = `${displayName}: ${inputText}`;
      state.discordSentMessages.add(claudeInput.trim());

      const sent = sessionManager.sendInput(effectiveClaudeSessionId, claudeInput);
      if (!sent) {
        state.discordSentMessages.delete(claudeInput.trim());
        await message.reply('⚠️ Failed to send input - session not connected.');
      }
      state.lastActiveAgent.set(threadId, 'claude');
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

    // Restore Codex sessions from persisted mappings (validate threads first)
    if (codexSessionManager) {
      const validated = await channelManager.validateAndCleanCodexMappings();
      const restorable = validated
        .filter(m => m.codexThreadId)
        .map(m => ({
          sessionId: m.sessionId,
          codexThreadId: m.codexThreadId!,
          cwd: m.cwd,
          discordThreadId: m.threadId,
        }));

      if (restorable.length > 0) {
        const restored = await codexSessionManager.restoreSessions(restorable);
        // Re-register thread mappings for restored sessions
        for (const m of restorable) {
          const mapping = channelManager.getCodexSession(m.sessionId);
          if (!mapping) {
            // Re-create in-memory mapping from persisted data
            const persisted2 = validated.find(p => p.sessionId === m.sessionId);
            if (persisted2) {
              channelManager.restoreCodexSessionMapping(persisted2);
            }
          }
        }
        log.info({ restored, total: restorable.length }, 'Codex session restoration complete');
      }
    }

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

  return { client, sessionManager, channelManager, codexSessionManager, claudeSdkSessionManager, cleanup };
}
