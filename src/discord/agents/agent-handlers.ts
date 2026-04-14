/**
 * Agent event handlers - converts AgentSessionManager events to Discord thread messages
 */

import type { Client, ThreadChannel } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { randomUUID } from 'crypto';
import { discordLogger as log } from '../../utils/logger.js';
import { chunkMessage } from '../../slack/message-formatter.js';
import { tryRouteToAgent } from '../agent-routing.js';
import { DISCORD_SAFE_CONTENT_LIMIT } from '../constants.js';
import type { ChannelManager } from '../channel-manager.js';
import type { DiscordState } from '../state.js';
import type { SessionManager } from '../../shared/session-manager.js';
import type { AgentEvents, AgentSessionManager } from './agent-session-manager.js';
import type { MemoryCollector } from '../../memory/memory-collector.js';
import { basename } from 'path';
import type { ClaudeSdkSessionManager } from '../claude-sdk/claude-sdk-session-manager.js';

interface AgentHandlerContext {
  client: Client;
  channelManager: ChannelManager;
  state: DiscordState;
  sessionManagerRef: { current: SessionManager | null };
  claudeSdkSessionManagerRef?: { current: ClaudeSdkSessionManager | undefined };
  agentSessionManagerRef: { current: AgentSessionManager | undefined };
  memoryCollector?: MemoryCollector;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

async function getAgentThread(
  client: Client,
  agentSessionManager: AgentSessionManager | undefined,
  sessionId: string,
): Promise<{ thread: ThreadChannel; modelAlias: string; displayName: string; cwd?: string } | null> {
  const session = agentSessionManager?.getSession(sessionId);
  if (!session) {
    log.debug({ sessionId }, 'getAgentThread: No agent session');
    return null;
  }
  try {
    const channel = await client.channels.fetch(session.discordThreadId);
    if (channel?.isThread()) {
      return {
        thread: channel,
        modelAlias: session.modelAlias,
        displayName: session.modelDef.displayName,
        cwd: session.cwd,
      };
    }
    log.debug({ threadId: session.discordThreadId }, 'getAgentThread: Channel is not a thread');
  } catch (err) {
    log.debug({ threadId: session.discordThreadId, err }, 'getAgentThread: Failed to fetch thread');
  }
  return null;
}

export function createAgentEvents(context: AgentHandlerContext): AgentEvents {
  const { client, channelManager, state } = context;

  const getAgentMgr = () => context.agentSessionManagerRef.current;

  return {
    onSessionStart: async (sessionId, modelAlias, cwd, threadId) => {
      log.info({ sessionId, modelAlias, cwd, threadId }, 'Agent session started (handler)');
    },

    onSessionEnd: (sessionId) => {
      log.info({ sessionId }, 'Agent session ended (handler)');
      // Stop typing indicator
      const interval = state.typingIntervals.get(`agent:${sessionId}`);
      if (interval) {
        clearInterval(interval);
        state.typingIntervals.delete(`agent:${sessionId}`);
      }
    },

    onSessionStatus: (sessionId, status) => {
      log.debug({ sessionId, status }, 'Agent session status change');

      if (status === 'running') {
        // Start typing indicator
        const startTyping = async () => {
          const result = await getAgentThread(client, getAgentMgr(), sessionId);
          if (result) {
            result.thread.sendTyping().catch(() => {});
          }
        };
        startTyping();
        const interval = setInterval(startTyping, 8000);
        state.typingIntervals.set(`agent:${sessionId}`, interval);
      } else {
        // Stop typing indicator
        const interval = state.typingIntervals.get(`agent:${sessionId}`);
        if (interval) {
          clearInterval(interval);
          state.typingIntervals.delete(`agent:${sessionId}`);
        }
      }
    },

    onMessage: async (sessionId, content) => {
      const result = await getAgentThread(client, getAgentMgr(), sessionId);
      if (!result) return;

      const { thread, modelAlias, displayName, cwd } = result;

      // Collect for memory
      if (context.memoryCollector && content.trim()) {
        const project = cwd ? basename(cwd) : undefined;
        context.memoryCollector.onMessage({
          speaker: 'system',  // MemorySpeaker doesn't include 'agent' yet
          displayName,
          content,
          channelId: thread.id,
          threadId: thread.id,
          project,
        }).catch(err => log.error({ err }, 'Memory collect failed'));
      }

      // Multi-agent routing: detect @claude or @codex in output
      const agents = channelManager.getAgentsInThread(thread.id);
      const hasOtherAgent = !!(agents.claude || agents.codex);
      if (hasOtherAgent) {
        const sessionManager = context.sessionManagerRef.current;
        const claudeSdkSessionManager = context.claudeSdkSessionManagerRef?.current;

        // Try route to Claude
        if (agents.claude) {
          const sdkSession = claudeSdkSessionManager?.getSession(agents.claude);
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
            sourceAgent: modelAlias as any,
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
      }

      const prefix = hasOtherAgent ? `**${displayName}:** ` : '';
      const maxLen = DISCORD_SAFE_CONTENT_LIMIT - prefix.length;
      const chunks = chunkMessage(content, maxLen);

      try {
        for (const chunk of chunks) {
          await thread.send(`${prefix}${chunk}`);
        }
      } catch (err: any) {
        log.error({ threadId: thread.id, error: err.message }, 'Failed to send agent message');
      }
    },

    onToolCall: async (sessionId, toolName, input) => {
      const result = await getAgentThread(client, getAgentMgr(), sessionId);
      if (!result) return;
      const { thread } = result;

      // Format tool call summary
      const maxArgLen = 80;
      const argSummary = Object.entries(input)
        .map(([k, v]) => {
          const val = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${val.length > maxArgLen ? val.slice(0, maxArgLen) + '...' : val}`;
        })
        .join(' ');

      const text = `⚙️ \`${toolName}\` ${argSummary}`.slice(0, DISCORD_SAFE_CONTENT_LIMIT);

      try {
        const msg = await thread.send(text);
        state.toolCallMessages.set(msg.id, {
          messageId: msg.id,
          toolName,
          filePath: (input.file_path as string) || undefined,
        });
      } catch (err: any) {
        log.error({ threadId: thread.id, error: err.message }, 'Failed to send agent tool call');
      }
    },

    onToolResult: async (sessionId, toolName, output, isError) => {
      const result = await getAgentThread(client, getAgentMgr(), sessionId);
      if (!result) return;
      const { thread } = result;

      // Write/Edit 시 파일 자동 업로드 (누락 보완 #5)
      if ((toolName === 'Write' || toolName === 'Edit') && !isError) {
        const pathMatch = output.match(/(?:File written|File edited): (.+)/);
        if (pathMatch?.[1]) {
          try {
            await thread.send({ files: [pathMatch[1]] });
          } catch {
            // 파일 업로드 실패는 무시
          }
        }
      }

      // 300자 초과 시 View Full 버튼 (누락 보완 #6)
      if (output.length > 300) {
        const resultId = randomUUID();
        state.pendingFullResults.set(resultId, {
          content: output,
          toolName,
          createdAt: Date.now(),
        });

        const truncated = output.slice(0, 300) + '... (truncated)';
        const emoji = isError ? '❌' : '✅';
        const text = `${emoji} \`${toolName}\` result:\n\`\`\`\n${truncated}\n\`\`\``;

        try {
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`fullresult:${resultId}`)
              .setLabel('View Full')
              .setStyle(ButtonStyle.Secondary),
          );
          await thread.send({ content: text.slice(0, DISCORD_SAFE_CONTENT_LIMIT), components: [row] });
        } catch (err: any) {
          log.error({ threadId: thread.id, error: err.message }, 'Failed to send tool result with button');
        }
      }
      // Short results for non-skip tools only
      else if (output.length > 0 && !['Read', 'Grep', 'Glob'].includes(toolName)) {
        const emoji = isError ? '❌' : '✅';
        const text = `${emoji} \`${toolName}\`: ${output}`.slice(0, DISCORD_SAFE_CONTENT_LIMIT);
        try {
          await thread.send(text);
        } catch { /* ignore */ }
      }
    },

    onPermissionRequest: async (sessionId, reqId, toolName, input) => {
      const result = await getAgentThread(client, getAgentMgr(), sessionId);
      if (!result) return false;
      const { thread } = result;

      return new Promise<boolean>((resolve) => {
        // 기존 perm:{requestId}:{decision} 패턴 재활용 (interactions/permissions.ts)
        const permId = `agent_${reqId}`;
        state.pendingPermissions.set(permId, {
          requestId: permId,
          sessionId,
          resolve: (decision) => resolve(decision.behavior === 'allow'),
        });

        // Format permission request
        const argSummary = Object.entries(input)
          .map(([k, v]) => {
            const val = typeof v === 'string' ? v : JSON.stringify(v);
            return `**${k}**: ${val.slice(0, 100)}`;
          })
          .join('\n');

        const text = `🔐 **Permission Request**\n\`${toolName}\`\n${argSummary}`;

        // perm:{requestId}:{decision} — 기존 handlePermissionButton이 처리
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`perm:${permId}:allow`)
            .setLabel('Allow')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`perm:${permId}:yolo`)
            .setLabel('YOLO')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`perm:${permId}:deny`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger),
        );
        thread.send({ content: text.slice(0, DISCORD_SAFE_CONTENT_LIMIT), components: [row] }).catch(() => {
          resolve(false);
        });
      });
    },

    onDenied: async (sessionId, toolName, message) => {
      const result = await getAgentThread(client, getAgentMgr(), sessionId);
      if (!result) return;

      try {
        await result.thread.send(`🚫 **Denied**: \`${toolName}\` — ${message}`);
      } catch { /* ignore */ }
    },

    onTurnComplete: async (sessionId, usage) => {
      const result = await getAgentThread(client, getAgentMgr(), sessionId);
      if (!result) return;

      const pct = Math.round((usage.contextUsed / usage.contextWindow) * 100);
      const bar = pct < 50 ? '🟢' : pct < 80 ? '🟡' : '🔴';
      const ctxUsed = formatTokens(usage.contextUsed);
      const ctxMax = formatTokens(usage.contextWindow);
      const line = `${bar} ${pct}% ctx (${ctxUsed}/${ctxMax}) · $${usage.totalCostUSD.toFixed(4)} · turn ${usage.turnNumber} · ${usage.model}`;

      try {
        await result.thread.send(line);
      } catch { /* ignore */ }
    },

    onError: (sessionId, error) => {
      log.error({ sessionId, error: error.message }, 'Agent session error');
      getAgentThread(client, getAgentMgr(), sessionId).then(result => {
        if (result) {
          const msg = error.message || '';
          let display: string;
          if (/credit|balance|insufficient/i.test(msg)) {
            display = `💳 **크레딧 부족** — API 크레딧을 확인해주세요`;
          } else if (/rate limit|too many requests|429/i.test(msg)) {
            display = `⏳ **Rate Limit** — 잠시 후 다시 시도해주세요`;
          } else if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(msg)) {
            display = `🌐 **네트워크 에러** — ${msg.slice(0, 100)}`;
          } else {
            display = `❌ **Error:** ${msg.slice(0, 300)}`;
          }
          result.thread.send(display).catch(() => {});
        }
      });
    },

    onCompaction: async (sessionId) => {
      const result = await getAgentThread(client, getAgentMgr(), sessionId);
      if (!result) return;

      try {
        await result.thread.send('🗜️ Compaction 완료 — 이전 대화가 요약되었습니다');
      } catch { /* ignore */ }
    },
  };
}
