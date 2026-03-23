/**
 * Codex event handlers - converts CodexSessionManager events to Discord thread messages
 */

import type { Client, ThreadChannel } from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import { chunkMessage } from '../../slack/message-formatter.js';
import { tryRouteToAgent } from '../agent-routing.js';
import { DISCORD_SAFE_CONTENT_LIMIT } from '../constants.js';
import type { ChannelManager } from '../channel-manager.js';
import type { DiscordState } from '../state.js';
import type { SessionManager } from '../../shared/session-manager.js';
import type { CodexEvents } from './codex-session-manager.js';
import type { MemoryCollector } from '../../memory/memory-collector.js';
import { basename } from 'path';
import type { ClaudeSdkSessionManager } from '../claude-sdk/claude-sdk-session-manager.js';

interface CodexHandlerContext {
  client: Client;
  channelManager: ChannelManager;
  state: DiscordState;
  sessionManagerRef: { current: SessionManager | null };
  claudeSdkSessionManagerRef?: { current: ClaudeSdkSessionManager | undefined };
  memoryCollector?: MemoryCollector;
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

const MAX_CMD_DISPLAY = 120;

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const wrapped = trimmed.match(/^(?:\/[\w/-]+\/)?(?:bash|zsh|sh)\s+-lc\s+(['"])([\s\S]*)\1$/i);
  return wrapped ? wrapped[2] : trimmed;
}

function normalizePathToken(token: string): string {
  const trimmed = token.trim();
  const unquoted = trimmed.replace(/^['"`](.*)['"`]$/, '$1');
  return unquoted.replace(/[;|&]+$/, '');
}

function getFileWriteTarget(command: string): string | null {
  const patterns = [
    /\bcat\s*>\s*(["'`]?[^"'`\s>;&|]+["'`]?)\s*<</i,
    /\bcat\s*<<[\s\S]*?>\s*(["'`]?[^"'`\s>;&|]+["'`]?)\b/i,
    /\btee(?:\s+-a)?\s+(["'`]?[^"'`\s>;&|]+["'`]?)\s*<</i,
    /\b(?:echo|printf)\b[\s\S]*?>>\s*(["'`]?[^"'`\s>;&|]+["'`]?)\b/i,
    /\b(?:echo|printf)\b[\s\S]*?>\s*(["'`]?[^"'`\s>;&|]+["'`]?)\b/i,
  ];

  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (match?.[1]) {
      return normalizePathToken(match[1]);
    }
  }

  return null;
}

function summarizeCommand(command: string): string {
  const unwrapped = unwrapShellCommand(command);
  const writeTarget = getFileWriteTarget(unwrapped);
  if (writeTarget) {
    return `write -> ${writeTarget}`;
  }

  return unwrapped.length > MAX_CMD_DISPLAY
    ? `${unwrapped.slice(0, MAX_CMD_DISPLAY)}...`
    : unwrapped;
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

      // Auto-route: detect @claude in Codex output → forward to Claude
      if (multiAgent) {
        const agents = channelManager.getAgentsInThread(thread.id);
        const sessionManager = context.sessionManagerRef.current;
        const claudeSdkSessionManager = context.claudeSdkSessionManagerRef?.current;
        const sdkSession = claudeSdkSessionManager?.getSession(agents.claude!);
        const targetAvailable = sdkSession
          ? sdkSession.status !== 'ended'
          : !!sessionManager;
        const sendToClaude = sdkSession
          ? (msg: string) => claudeSdkSessionManager!.sendInput(agents.claude!, msg)
          : (msg: string) => sessionManager!.sendInput(agents.claude!, msg);
        const { routed } = await tryRouteToAgent({
          thread,
          content,
          agents,
          sourceAgent: 'codex',
          state,
          target: {
            agent: 'claude',
            transportType: sdkSession ? 'sdk' : 'pty',
            isAvailable: () => targetAvailable,
            send: sendToClaude,
          },
          isTargetAvailable: () => targetAvailable,
          sendToTarget: sendToClaude,
          onBeforeSend: (msg) => state.discordSentMessages.add(msg.trim()),
        });
        if (routed) return;
      }

      // Collect Codex response for memory
      if (context.memoryCollector && content.trim()) {
        const mapping = channelManager.getCodexSession(sessionId);
        const project = mapping?.cwd ? basename(mapping.cwd) : undefined;
        context.memoryCollector.onMessage({
          speaker: 'codex',
          displayName: 'Codex',
          content,
          channelId: thread.id,
          threadId: thread.id,
          project,
        }).catch(err => log.error({ err }, 'Memory collect failed'));
      }

      const prefix = multiAgent ? '**Codex:** ' : '';
      const maxLen = DISCORD_SAFE_CONTENT_LIMIT - prefix.length;
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

      const isError = info.exitCode !== undefined && info.exitCode !== 0;
      const duration = info.durationMs ? `, ${(info.durationMs / 1000).toFixed(1)}s` : '';
      const exitLabel = info.exitCode !== undefined ? `exit: ${info.exitCode}` : 'done';
      const displayCommand = summarizeCommand(info.command);

      let text: string;
      if (isError && info.output) {
        // Show error output (truncated)
        const maxOutput = 500;
        const output = info.output.length > maxOutput
          ? info.output.slice(0, maxOutput) + '\n... (truncated)'
          : info.output;
        text = `⚙️ \`${displayCommand}\` (${exitLabel}${duration})\n\`\`\`\n${output}\n\`\`\``;
      } else {
        // One-line summary for successful commands
        text = `⚙️ \`${displayCommand}\` (${exitLabel}${duration})`;
      }

      try {
        await thread.send(text.slice(0, DISCORD_SAFE_CONTENT_LIMIT));
      } catch (err: any) {
        log.error({ threadId: thread.id, error: err.message }, 'Failed to send Codex command execution');
      }
    },

    onFileChange: async (sessionId, info) => {
      const thread = await getCodexThread(client, channelManager, sessionId);
      if (!thread) return;

      const count = info.changes.length;
      const maxInline = 5;

      let text: string;
      if (count <= maxInline) {
        const names = info.changes.map(c => `\`${c.path.split('/').pop()}\``).join(', ');
        text = `📝 ${count} file${count > 1 ? 's' : ''} changed: ${names}`;
      } else {
        const shown = info.changes.slice(0, maxInline).map(c => `\`${c.path.split('/').pop()}\``).join(', ');
        text = `📝 ${count} files changed: ${shown} +${count - maxInline} more`;
      }

      try {
        await thread.send(text.slice(0, DISCORD_SAFE_CONTENT_LIMIT));
      } catch (err: any) {
        log.error({ threadId: thread.id, error: err.message }, 'Failed to send Codex file change');
      }
    },

    onTurnComplete: async (sessionId, usage, turnNumber) => {
      const thread = await getCodexThread(client, channelManager, sessionId);
      if (!thread) return;

      const formatTokens = (n: number): string => {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
        return String(n);
      };

      const line = `📊 Codex: ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out · turn ${turnNumber}`;
      try {
        await thread.send(line);
      } catch { /* ignore */ }
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
