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
import { SessionManager } from '../shared/session-manager.js';
import { ChannelManager } from './channel-manager.js';
import { discordLogger as log } from '../utils/logger.js';
import type { ProcessManager } from './process-manager.js';
import type { SettingsManager } from './settings-manager.js';
import { CodexSessionManager } from './codex/codex-session-manager.js';
import { createCodexEvents } from './codex/codex-handlers.js';
import { CODEX_MODEL } from './codex/codex-session-manager.js';
import { ClaudeSdkSessionManager, type ClaudeSdkSessionEntry } from './claude-sdk/claude-sdk-session-manager.js';
import { createClaudeSdkHandlers } from './claude-sdk/claude-sdk-handlers.js';
import { AgentSessionManager } from './agents/agent-session-manager.js';
import { createAgentEvents } from './agents/agent-handlers.js';
import { ControlPanel } from './control-panel.js';

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
import { BatchDistillRunner } from '../memory/batch-distill-runner.js';
import { DailyDigestRunner } from '../memory/daily-digest.js';
import { MemoryReporter } from './memory-reporter.js';
import { loadMemoryConfig, ensureConfigFile, getMemoryConfig, stopConfigWatcher } from '../memory/memory-config.js';
import { MemoryAuthorityClient } from '../memory/memory-authority-client.js';

export interface DiscordAppOptions {
  config: DiscordConfig;
  processManager?: ProcessManager;
  settingsManager?: SettingsManager;
  enableCodex?: boolean;
  memoryCollector?: MemoryCollector;
  memoryClient?: MemoryAuthorityClient;
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

  // Memory system references (initialized after bot is ready)
  let memoryReporter: MemoryReporter | undefined;
  let batchDistillRunner: BatchDistillRunner | undefined;
  let dailyDigestRunner: DailyDigestRunner | undefined;

  // Memory Authority client — single writer for LanceDB via MCP server
  const memoryClient = options?.memoryClient ?? new MemoryAuthorityClient();

  // Create a ref for lazy sessionManager access (needed for circular dependency)
  const sessionManagerRef: SessionManagerRef = { current: null };
  const claudeSdkSessionManagerRef: { current: ClaudeSdkSessionManager | undefined } = { current: undefined };
  const codexSessionManagerRef: { current: CodexSessionManager | undefined } = { current: undefined };
  const agentSessionManagerRef: { current: AgentSessionManager | undefined } = { current: undefined };

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
    codexSessionManagerRef.current = codexSessionManager;
    log.info('Codex session manager initialized');
  }

  // Initialize Agent session manager (OpenRouter/DeepInfra models)
  const enableAgents = !!(process.env.OPENROUTER_API_KEY || process.env.DEEPINFRA_API_KEY);
  let agentSessionManager: AgentSessionManager | undefined;
  if (enableAgents) {
    const agentEvents = createAgentEvents({
      client,
      channelManager,
      state,
      sessionManagerRef,
      claudeSdkSessionManagerRef,
      codexSessionManagerRef,
      agentSessionManagerRef,
      memoryCollector: options?.memoryCollector,
    });
    agentSessionManager = new AgentSessionManager(agentEvents, {
      isYolo: (threadId: string) => {
        // Check if any session in this thread has YOLO enabled
        const agents = channelManager.getAgentsInThread(threadId);
        const sessionIds = [agents.claude, agents.codex, agents.agent].filter(Boolean) as string[];
        for (const sessionId of sessionIds) {
          if (state.yoloSessions.has(sessionId)) return true;
        }
        return false;
      },
      // #4: maxConcurrentSessions — count other session types
      maxConcurrentSessions: settingsManager?.getMaxSessions(),
      getActiveCounts: () => {
        const sdkCount = claudeSdkSessionManagerRef.current?.getAllSessions().filter(s => s.status !== 'ended').length ?? 0;
        const codexCount = codexSessionManager?.getAllSessions().filter(s => s.status !== 'ended').length ?? 0;
        return sdkCount + codexCount;
      },
    });
    agentSessionManagerRef.current = agentSessionManager;
    // Stop 시 pending permission promise 정리 (Promise leak 방지)
    agentSessionManager.pendingPermissionCleanup = (sessionId: string) => {
      for (const [permId, pending] of state.pendingPermissions) {
        if (pending.sessionId === sessionId) {
          pending.resolve({ behavior: 'deny', message: 'Session stopped' });
          state.pendingPermissions.delete(permId);
        }
      }
    };
    log.info('Agent session manager initialized (OpenRouter/DeepInfra)');
  }

  // Single-flight map to prevent duplicate lazy resume attempts for the same session
  const pendingLazyResumes = new Map<string, Promise<ClaudeSdkSessionEntry | null>>();

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

  // Create command/interaction context (use getter for lazy references)
  const commandContext: CommandContext & { batchDistillRunner?: BatchDistillRunner; dailyDigestRunner?: import('../memory/daily-digest.js').DailyDigestRunner; memoryReporter?: MemoryReporter } = {
    client,
    channelManager,
    sessionManager,
    processManager,
    settingsManager,
    codexSessionManager,
    claudeSdkSessionManager,
    agentSessionManager,
    state,
    get batchDistillRunner() { return batchDistillRunner; },
    get dailyDigestRunner() { return dailyDigestRunner; },
    get memoryReporter() { return memoryReporter; },
    memoryClient,
  };

  const interactionContext: InteractionContext = commandContext;

  // ── Message Debounce Queue ─────────────────────────────────
  // Collect rapid-fire user messages (within 3s) and deliver as one batch
  const DEBOUNCE_MS = 3000;
  const messageQueue = new Map<string, {
    messages: typeof import('discord.js').Message[];
    timer: ReturnType<typeof setTimeout>;
  }>();

  function flushMessageQueue(threadId: string) {
    const entry = messageQueue.get(threadId);
    if (!entry || entry.messages.length === 0) return;
    messageQueue.delete(threadId);
    processMessages(entry.messages).catch(err =>
      log.error({ err, threadId }, 'Failed to process debounced messages'),
    );
  }

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

    // Check which agents are active in this thread (includes agent sessions)
    const agents = channelManager.getAgentsInThread(threadId);
    const hasAgentSession = !!agentSessionManager?.getSessionByDiscordThread(threadId);
    if (!agents.claude && !agents.codex && !hasAgentSession) return;

    // Quick interrupt commands bypass debounce
    const INTERRUPT_COMMANDS = new Set(['!중지', '!halt', '!잠깐']);
    if (INTERRUPT_COMMANDS.has(message.content.trim().toLowerCase())) {
      // Flush any pending messages first
      const pending = messageQueue.get(threadId);
      if (pending) {
        clearTimeout(pending.timer);
        flushMessageQueue(threadId);
      }
      processMessages([message]).catch(err =>
        log.error({ err, threadId }, 'Failed to process interrupt message'),
      );
      return;
    }

    // Add to debounce queue
    const existing = messageQueue.get(threadId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.timer = setTimeout(() => flushMessageQueue(threadId), DEBOUNCE_MS);
    } else {
      messageQueue.set(threadId, {
        messages: [message],
        timer: setTimeout(() => flushMessageQueue(threadId), DEBOUNCE_MS),
      });
    }
  });

  // Process a batch of debounced messages
  async function processMessages(messages: any[]) {
    if (messages.length === 0) return;
    const firstMessage = messages[0];
    const threadId = firstMessage.channelId;

    // Check which agents are active in this thread
    const agentSession = agentSessionManager?.getSessionByDiscordThread(threadId);
    const agents = channelManager.getAgentsInThread(threadId);
    const claudeSessionId = agents.claude;
    const codexSessionId = agents.codex;

    if (!claudeSessionId && !codexSessionId && !agentSession) return;

    // Build agent presence map for routing context
    const hasAgents = new Map<string, boolean>();
    for (const [alias] of agents.agentAliases) {
      hasAgents.set(alias, true);
    }

    // Use first message for routing (determines @claude vs @codex vs @gemma4 etc.)
    const directive = parseRoutingDirective(firstMessage.content, {
      hasClaude: !!claudeSessionId,
      hasCodex: !!codexSessionId,
      hasAgents,
      lastActive: state.lastActiveAgent.get(threadId),
    });
    const { target, invalidMention } = directive;

    // Merge all message contents
    const allContents: string[] = [];
    for (const msg of messages) {
      const d = parseRoutingDirective(msg.content, {
        hasClaude: !!claudeSessionId,
        hasCodex: !!codexSessionId,
        hasAgents,
        lastActive: state.lastActiveAgent.get(threadId),
      });
      allContents.push(d.cleanContent);
    }
    const cleanContent = allContents.join('\n');

    log.info({ threadId, target, explicit: directive.explicit, msgCount: messages.length, contentPreview: cleanContent.slice(0, 80) }, 'Routing message');

    // Warn if @mention is in body but not at the start (multi-agent only)
    if (invalidMention && claudeSessionId && codexSessionId) {
      await firstMessage.reply('💡 `@codex`/`@claude` must be the **first word** of your message to route it. Your message was sent to the default agent.').catch(() => {});
    }

    // Reset agent-to-agent routing counter on user message
    state.agentRoutingCount.set(threadId, 0);

    // React with checkmark on all messages to acknowledge receipt
    await Promise.all(messages.map(msg => msg.react('✅').catch(() => {})));

    // Collect user message for memory
    if (handlerContext.memoryCollector && cleanContent.trim()) {
      const claudeMapping = claudeSessionId
        ? channelManager.getSession(claudeSessionId) ?? channelManager.getSdkSession(claudeSessionId)
        : undefined;
      const sessionCwd = claudeMapping?.cwd;
      handlerContext.memoryCollector.onMessage({
        speaker: 'user',
        displayName: firstMessage.member?.displayName ?? firstMessage.author.username,
        content: cleanContent,
        channelId: firstMessage.channel.parentId ?? firstMessage.channelId,
        threadId: firstMessage.channelId,
        project: sessionCwd ? basename(sessionCwd) : undefined,
      }).catch(err => log.error({ err }, 'Memory collect failed'));
    }

    // Download any image attachments from all messages
    const imagePaths: string[] = [];
    const textContents: string[] = [];
    const errors: string[] = [];

    for (const msg of messages) {
      for (const [, attachment] of msg.attachments) {
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
    }

    // Report errors if any
    if (errors.length > 0) {
      await firstMessage.reply(`⚠️ ${errors.join('\n')}`);
      if (textContents.length === 0 && imagePaths.length === 0 && !cleanContent.trim()) {
        return; // Nothing to send
      }
    }

    // Prefix with Discord display name so agents can identify the human speaker
    const displayName = firstMessage.member?.displayName ?? firstMessage.author.displayName ?? firstMessage.author.username;

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

    // Quick interrupt: short text commands to interrupt active agent
    const INTERRUPT_COMMANDS = new Set(['!중지', '!halt', '!잠깐']);
    if (INTERRUPT_COMMANDS.has(inputText.trim().toLowerCase())) {
      let interrupted = false;
      const activeAgent = state.lastActiveAgent.get(threadId);

      // Try Claude SDK first
      if (claudeSessionId && (!activeAgent || activeAgent === 'claude')) {
        let sdkSession = claudeSdkSessionManager.getSession(claudeSessionId);

        // Fallback: try finding by thread if not found by sessionId
        if ((!sdkSession || sdkSession.status !== 'running') && threadId) {
          const byThread = claudeSdkSessionManager.getSessionByThread(threadId);
          if (byThread && byThread.status === 'running') {
            log.warn({ claudeSessionId, threadId, foundSessionId: byThread.id, pid: process.pid }, 'Interrupt: session not found by ID, found by thread fallback');
            sdkSession = byThread;
          }
        }

        if (sdkSession && sdkSession.status === 'running') {
          claudeSdkSessionManager.interruptSession(sdkSession.id);
          interrupted = true;
        } else {
          // Log detailed diagnostic info on interrupt failure
          const allSessions = claudeSdkSessionManager.getAllSessions();
          log.warn({
            claudeSessionId,
            threadId,
            sdkSessionStatus: sdkSession?.status,
            sdkSessionId: sdkSession?.id,
            activeSessions: allSessions.map(s => ({ id: s.id, threadId: s.discordThreadId, status: s.status })),
            pid: process.pid,
          }, 'Interrupt failed: no running SDK session found');
        }
      }

      // Try Codex
      if (!interrupted && codexSessionId && codexSessionManager && (!activeAgent || activeAgent === 'codex')) {
        const codexSession = codexSessionManager.getSession(codexSessionId);
        if (codexSession && codexSession.status === 'running') {
          codexSessionManager.interruptSession(codexSessionId);
          interrupted = true;
        }
      }

      // Try Agent session (OpenRouter/DeepInfra models)
      if (!interrupted && agentSession && agentSessionManager) {
        if (agentSession.status === 'running') {
          agentSessionManager.interruptSession(agentSession.id);
          interrupted = true;
        }
      }

      // Try PTY (send Escape x2)
      if (!interrupted && claudeSessionId) {
        const channel = channelManager.getSession(claudeSessionId);
        if (channel && channel.status === 'running') {
          sessionManager.sendInput(claudeSessionId, '\x1b\x1b', false);
          interrupted = true;
        }
      }

      if (interrupted) {
        await firstMessage.react('🛑');
      } else {
        await firstMessage.reply('⚠️ No active session to interrupt.');
      }
      return;
    }

    // Route to agent session if it's the only session in this thread (no claude/codex)
    if (!claudeSessionId && !codexSessionId && agentSession && agentSessionManager) {
      const agentInput = `${displayName}: ${inputText}`;
      const sent = await agentSessionManager.sendInput(agentSession.id, agentInput);
      if (!sent) {
        await firstMessage.reply('⚠️ Failed to send input to agent - session busy or ended.');
      }
      return;
    }

    // Route to generic agent if target is a model alias
    if (target !== 'claude' && target !== 'codex' && hasAgents.has(target)) {
      const targetSessionId = agents.agentAliases.get(target);
      const targetSession = targetSessionId ? agentSessionManager?.getSession(targetSessionId) : null;
      if (targetSession && agentSessionManager) {
        const agentInput = `${displayName}: ${inputText}`;
        const sent = await agentSessionManager.sendInput(targetSession.id, agentInput);
        if (!sent) {
          await firstMessage.reply(`⚠️ Failed to send input to ${target} — session busy or ended.`);
        }
        state.lastActiveAgent.set(threadId, target);
      } else {
        await firstMessage.reply(`⚠️ @${target} session is not active in this thread.`);
      }
      return;
    }

    // Route to the correct agent
    if (target === 'codex') {
      if (!codexSessionManager) {
        await firstMessage.reply('⚠️ Codex is not enabled.');
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
          await firstMessage.reply('⚠️ Cannot determine working directory for Codex.');
          return;
        }

        try {
          const mapping = await channelManager.createCodexSession('pending', 'codex-auto', claudeMapping.cwd, threadId);
          if (!mapping) {
            await firstMessage.reply('⚠️ Failed to create Codex session.');
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
            await firstMessage.channel.send(`**Codex joined this thread.** Model: \`${CODEX_MODEL}\`. Messages are prefixed with agent names.`);
          } catch { /* ignore */ }
        } catch (err) {
          log.error({ err }, 'Failed to auto-create Codex session');
          await firstMessage.reply(`⚠️ Failed to start Codex: ${(err as Error).message}`);
          return;
        }
      }

      const codexInput = `${displayName}: ${inputText}`;
      const sent = await codexSessionManager.sendInput(effectiveCodexSessionId, codexInput);
      if (!sent) {
        await firstMessage.reply('⚠️ Failed to send input to Codex - session busy or ended.');
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
          await firstMessage.reply('⚠️ No Claude session in this thread. Use `/claude start` or `/claude start-sdk` first.');
          return;
        }

        try {
          const sdkSessionId = randomUUID();
          const sessionName = `claude-sdk-auto`;
          const mapping = await channelManager.createSdkSession(sdkSessionId, sessionName, codexEntry.cwd, threadId);
          if (!mapping) {
            await firstMessage.reply('⚠️ Failed to create Claude SDK session.');
            return;
          }

          const entry = await claudeSdkSessionManager.startSession(codexEntry.cwd, mapping.threadId, {
            sessionId: sdkSessionId,
          });
          channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);
          effectiveClaudeSessionId = entry.id;
          log.info({ sessionId: entry.id, cwd: codexEntry.cwd }, 'Auto-created Claude SDK session in existing thread');

          try {
            await firstMessage.channel.send('**Claude joined this thread (SDK mode).** Messages are prefixed with agent names.');
          } catch { /* ignore */ }
        } catch (err) {
          log.error({ err }, 'Failed to auto-create Claude SDK session');
          await firstMessage.reply(`⚠️ Failed to start Claude SDK: ${(err as Error).message}`);
          return;
        }
      }

      let sdkSession = claudeSdkSessionManager.getSession(effectiveClaudeSessionId);

      // Lazy Resume: mapping exists but no active SDK process (e.g. after bot restart)
      if (!sdkSession || sdkSession.status === 'ended') {
        log.info({ sessionId: effectiveClaudeSessionId, threadId, pid: process.pid }, 'Lazy resume: checking');

        const pending = pendingLazyResumes.get(effectiveClaudeSessionId);
        if (pending) {
          log.info({ sessionId: effectiveClaudeSessionId, pid: process.pid }, 'Lazy resume: already in flight, awaiting');
          sdkSession = await pending ?? undefined;
        } else {
          const persisted = channelManager.getPersistedSdkMappings().find(m => m.sessionId === effectiveClaudeSessionId);
          if (persisted) {
            const resumePromise = (async (): Promise<ClaudeSdkSessionEntry | null> => {
              // If sdkSessionId was never properly updated (equals internal sessionId),
              // skip resume and go straight to fresh start
              const canResume = persisted.sdkSessionId && persisted.sdkSessionId !== persisted.sessionId;

              if (canResume) {
                log.info({ sessionId: effectiveClaudeSessionId, sdkSessionId: persisted.sdkSessionId, cwd: persisted.cwd, pid: process.pid }, 'Lazy-resuming SDK session after bot restart');
                try {
                  const entry = await claudeSdkSessionManager.startSession(persisted.cwd, persisted.threadId!, {
                    sessionId: persisted.sessionId,
                    resume: persisted.sdkSessionId,
                  });
                  channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);
                  return entry;
                } catch (resumeErr) {
                  log.warn({ err: resumeErr, sessionId: effectiveClaudeSessionId, pid: process.pid }, 'Lazy resume failed, trying fresh start');
                  try {
                    const entry = await claudeSdkSessionManager.startSession(persisted.cwd, persisted.threadId!, {
                      sessionId: persisted.sessionId,
                    });
                    channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);
                    return entry;
                  } catch (freshErr) {
                    log.error({ err: freshErr, sessionId: effectiveClaudeSessionId, pid: process.pid }, 'Fresh start also failed');
                    return null;
                  }
                }
              } else {
                log.warn({ sessionId: effectiveClaudeSessionId, pid: process.pid }, 'Skipping resume: sdkSessionId is corrupted (equals sessionId), starting fresh');
                try {
                  const entry = await claudeSdkSessionManager.startSession(persisted.cwd, persisted.threadId!, {
                    sessionId: persisted.sessionId,
                  });
                  channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);
                  return entry;
                } catch (freshErr) {
                  log.error({ err: freshErr, sessionId: effectiveClaudeSessionId, pid: process.pid }, 'Fresh start failed');
                  return null;
                }
              }
            })();

            pendingLazyResumes.set(effectiveClaudeSessionId, resumePromise);
            try {
              const result = await resumePromise;
              if (result) {
                sdkSession = result;
              } else {
                await firstMessage.reply('⚠️ Failed to resume Claude session. Use `/claude start-sdk` to start a new one.');
                return;
              }
            } finally {
              pendingLazyResumes.delete(effectiveClaudeSessionId);
            }
          }
        }
      }

      if (sdkSession && sdkSession.status !== 'ended') {
        const claudeInput = `${displayName}: ${inputText}`;
        const sent = claudeSdkSessionManager.sendInput(effectiveClaudeSessionId, claudeInput);
        if (!sent) {
          await firstMessage.reply('⚠️ Failed to send input to Claude SDK - session busy or ended.');
          return;
        }

        state.lastActiveAgent.set(threadId, 'claude');
        return;
      }

      const channel = channelManager.getSession(effectiveClaudeSessionId);
      if (!channel || channel.status === 'ended') {
        await firstMessage.reply('⚠️ This Claude session has ended.');
        return;
      }

      // Track this message so we don't re-post it
      const claudeInput = `${displayName}: ${inputText}`;
      state.discordSentMessages.add(claudeInput.trim());

      const sent = sessionManager.sendInput(effectiveClaudeSessionId, claudeInput);
      if (!sent) {
        state.discordSentMessages.delete(claudeInput.trim());
        await firstMessage.reply('⚠️ Failed to send input - session not connected.');
      }
      state.lastActiveAgent.set(threadId, 'claude');
    }
  }

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

    // Restore agent sessions (generic agents) from persisted mappings
    if (agentSessionManager) {
      const agentMappings = channelManager.getPersistedAgentMappings();
      if (agentMappings.length > 0) {
        const restorable = agentMappings
          .filter(m => m.cwd && m.threadId && m.modelAlias)
          .map(m => ({
            sessionId: m.sessionId,
            modelAlias: m.modelAlias!,
            cwd: m.cwd!,
            discordThreadId: m.threadId,
          }));

        if (restorable.length > 0) {
          // Rebuild in-memory channelManager mappings first
          for (const m of agentMappings.filter(p => p.modelAlias)) {
            channelManager.restoreAgentSessionMapping(m);
          }
          const restored = await agentSessionManager.restoreSessions(restorable);
          log.info({ restored, total: restorable.length }, 'Agent session restoration complete');
        }
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

    // Initialize control panel
    try {
      const controlPanel = new ControlPanel(client);
      await controlPanel.initialize();
    } catch (err) {
      log.error({ err }, 'Failed to initialize control panel');
    }

    // Initialize memory system (batch distill + reporter)
    if (memoryClient && process.env.DISABLE_MEMORY !== '1') {
      try {
        await ensureConfigFile();
        await loadMemoryConfig();

        // Create reporter
        memoryReporter = new MemoryReporter(client, config.userId);
        await memoryReporter.initialize();

        // Create batch distill runner with reporter events
        batchDistillRunner = new BatchDistillRunner(
          memoryClient,
          {
            onBatchComplete: async (result) => {
              await memoryReporter?.postBatchResult(result);
            },
            onSessionRefresh: async () => {
              log.info('Distill SDK session refreshed');
            },
            onError: async (error) => {
              log.error({ err: error }, 'Batch distill error');
            },
            onConfigChange: async (summary) => {
              await memoryReporter?.postNotification(summary);
            },
            onConsolidationComplete: async (report) => {
              await memoryReporter?.postConsolidationResult(report);
            },
          },
        );

        // Attach batch runner to memory collector
        if (options.memoryCollector) {
          options.memoryCollector.setBatchRunner(batchDistillRunner);
        }

        await batchDistillRunner.start();
        log.info('Memory batch distill system initialized');

        // Initialize daily digest
        dailyDigestRunner = new DailyDigestRunner(
          memoryClient,
          {
            onDigestReady: async (digest) => {
              await memoryReporter?.postDigest(digest);
            },
            onPreConsolidation: async (report) => {
              if (report.totalMerged > 0 || report.totalCleaned > 0) {
                await memoryReporter?.postConsolidationResult(report);
              }
            },
            onError: async (error) => {
              log.error({ err: error }, 'Daily digest error');
            },
          },
        );
        await dailyDigestRunner.start();
        log.info('Daily digest system initialized');

        // Post startup notification
        const config2 = getMemoryConfig();
        if (config2.distill.enabled) {
          const digestInfo = config2.digest.enabled
            ? `, digest: ${config2.digest.schedule.join('/')} ${config2.digest.timezone}`
            : '';
          await memoryReporter.postNotification(
            `▶️ **Memory system started** (model: \`${config2.distill.model}\`, batch: ${config2.distill.batchMaxMessages}/${Math.round(config2.distill.batchIntervalMs / 1000)}s${digestInfo})`,
          );
        }
      } catch (err) {
        log.error({ err }, 'Failed to initialize memory batch distill system');
      }
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
  const cleanup = async () => {
    cleanupState(state);
    if (batchDistillRunner) {
      await batchDistillRunner.stop();
    }
    if (dailyDigestRunner) {
      await dailyDigestRunner.stop();
    }
    stopConfigWatcher();
  };

  return { client, sessionManager, channelManager, codexSessionManager, claudeSdkSessionManager, cleanup };
}
