/**
 * Shared agent-to-agent routing logic
 * Used by both Claude→Codex (message.ts) and Codex→Claude (codex-handlers.ts)
 */

import type { ThreadChannel } from 'discord.js';
import { discordLogger as log } from '../utils/logger.js';
import { parseRoutingDirective } from './utils.js';
import { MAX_AGENT_ROUTING } from './state.js';
import type { DiscordState } from './state.js';
import { DISCORD_SAFE_CONTENT_LIMIT } from './constants.js';

type AgentType = 'claude' | 'codex';

export interface RouteParams {
  thread: ThreadChannel;
  content: string;
  agents: { claude?: string; codex?: string };
  sourceAgent: AgentType;
  state: DiscordState;
  sendToTarget: (content: string) => Promise<boolean> | boolean;
  isTargetAvailable: () => boolean;
  onBeforeSend?: (content: string) => void;
}

export interface RouteResult {
  routed: boolean;
}

/**
 * Try to route a message from one agent to another.
 * Returns { routed: true } if the message was forwarded (caller should skip normal display).
 */
export async function tryRouteToAgent(params: RouteParams): Promise<RouteResult> {
  const { thread, content, agents, sourceAgent, state, sendToTarget, isTargetAvailable, onBeforeSend } = params;
  const targetAgent: AgentType = sourceAgent === 'claude' ? 'codex' : 'claude';

  const directive = parseRoutingDirective(content, {
    hasClaude: !!agents.claude,
    hasCodex: !!agents.codex,
    lastActive: sourceAgent,
  });

  const shouldRoute =
    (directive.explicit && directive.target === targetAgent) ||
    (!directive.explicit && directive.invalidMention && directive.bodyMentionTarget === targetAgent);

  if (!shouldRoute || !agents[targetAgent]) {
    return { routed: false };
  }

  const isFallback = !directive.explicit;
  const routeContent = directive.explicit ? directive.cleanContent : content;

  if (!routeContent.trim()) {
    return { routed: false };
  }

  const routingCount = state.agentRoutingCount.get(thread.id) ?? 0;
  if (routingCount >= MAX_AGENT_ROUTING) {
    log.info({ threadId: thread.id, routingCount }, 'Agent routing limit reached, displaying normally');
    try {
      await thread.send(`⚠️ Agent routing limit (${MAX_AGENT_ROUTING}) reached. Displaying message instead.`);
    } catch { /* ignore */ }
    return { routed: false };
  }

  if (!isTargetAvailable()) {
    const label = targetAgent === 'codex' ? 'Codex session is not active' : 'Claude session is not available';
    try {
      await thread.send(`⚠️ @${targetAgent} mention detected but ${label}. Displaying normally.`);
    } catch { /* ignore */ }
    return { routed: false };
  }

  // Route the message
  state.agentRoutingCount.set(thread.id, routingCount + 1);
  const sourceLabel = sourceAgent.charAt(0).toUpperCase() + sourceAgent.slice(1);
  const targetLabel = targetAgent.charAt(0).toUpperCase() + targetAgent.slice(1);
  const routeLabel = isFallback
    ? `${sourceLabel} → ${targetLabel} ✉️`
    : `${sourceLabel} → ${targetLabel}`;

  log.info({ from: sourceAgent, to: targetAgent, count: routingCount + 1, fallback: isFallback, preview: routeContent.slice(0, 50) }, 'Agent-to-agent routing');

  try {
    await thread.send(`**${routeLabel}:** ${routeContent.slice(0, DISCORD_SAFE_CONTENT_LIMIT)}`);
  } catch { /* ignore */ }

  const messageForTarget = `${sourceLabel}: ${routeContent}\n\n(Start with @${sourceAgent} to reply)`;

  if (onBeforeSend) {
    onBeforeSend(messageForTarget);
  }

  const sent = await Promise.resolve(sendToTarget(messageForTarget));
  if (!sent) {
    try {
      const failMsg = targetAgent === 'codex'
        ? 'Codex is busy or session ended. Message was not delivered.'
        : 'Claude session is busy or ended. Message was not delivered.';
      await thread.send(`⚠️ ${failMsg}`);
    } catch { /* ignore */ }
  }

  state.lastActiveAgent.set(thread.id, targetAgent);
  return { routed: true };
}
