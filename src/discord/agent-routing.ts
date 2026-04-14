/**
 * Shared agent-to-agent routing logic (N-agent support)
 * Used by Claude→Codex, Codex→Claude, Agent→Claude/Codex, and Agent→Agent
 */

import type { ThreadChannel } from 'discord.js';
import { discordLogger as log } from '../utils/logger.js';
import { parseRoutingDirective, type AgentType } from './utils.js';
import { MAX_AGENT_ROUTING } from './state.js';
import type { DiscordState } from './state.js';
import { DISCORD_SAFE_CONTENT_LIMIT } from './constants.js';
import type { ClaudeTransport } from './claude-transport.js';

export interface AgentRouteTarget {
  agent: string;
  transportType?: ClaudeTransport['type'];
  isAvailable: () => boolean;
  send: (content: string) => Promise<boolean> | boolean;
}

export interface RouteParams {
  thread: ThreadChannel;
  content: string;
  /** All agents present in the thread: { claude, codex, agentAliases } */
  agents: { claude?: string; codex?: string; agentAliases: Map<string, string> };
  sourceAgent: string;
  state: DiscordState;
  /** Explicit route target — if provided, skips auto-detection */
  target?: AgentRouteTarget;
  /** Fallback target resolution for when no explicit target is given */
  resolveTarget?: (targetAgent: string) => AgentRouteTarget | null;
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
  const { thread, content, agents, sourceAgent, onBeforeSend, state, target, resolveTarget } = params;

  // Build routing context
  const hasAgents = new Map<string, boolean>();
  for (const [alias] of agents.agentAliases) {
    hasAgents.set(alias, true);
  }

  const directive = parseRoutingDirective(content, {
    hasClaude: !!agents.claude,
    hasCodex: !!agents.codex,
    hasAgents,
    lastActive: sourceAgent,
  });

  // Determine target from directive
  let targetAgent: string | undefined;
  if (directive.explicit && directive.target !== sourceAgent) {
    targetAgent = directive.target;
  } else if (!directive.explicit && directive.invalidMention && directive.bodyMentionTarget && directive.bodyMentionTarget !== sourceAgent) {
    targetAgent = directive.bodyMentionTarget;
  }

  if (!targetAgent) return { routed: false };

  // Check if target agent exists in thread
  const targetExists = targetAgent === 'claude' ? !!agents.claude
    : targetAgent === 'codex' ? !!agents.codex
    : agents.agentAliases.has(targetAgent);

  if (!targetExists) return { routed: false };

  const isFallback = !directive.explicit;
  const routeContent = directive.explicit ? directive.cleanContent : content;
  if (!routeContent.trim()) return { routed: false };

  // Routing limit
  const routingCount = state.agentRoutingCount.get(thread.id) ?? 0;
  if (routingCount >= MAX_AGENT_ROUTING) {
    log.info({ threadId: thread.id, routingCount }, 'Agent routing limit reached, displaying normally');
    try {
      await thread.send(`⚠️ Agent routing limit (${MAX_AGENT_ROUTING}) reached. Displaying message instead.`);
    } catch { /* ignore */ }
    return { routed: false };
  }

  // Resolve target
  const routeTarget: AgentRouteTarget | null = target?.agent === targetAgent
    ? target
    : resolveTarget?.(targetAgent) ?? null;

  if (!routeTarget) {
    // Fallback: use legacy sendToTarget/isTargetAvailable if target matches the old binary pattern
    const legacyTarget: AgentRouteTarget = {
      agent: targetAgent,
      isAvailable: params.isTargetAvailable,
      send: params.sendToTarget,
    };
    if (!legacyTarget.isAvailable()) {
      try {
        await thread.send(`⚠️ @${targetAgent} session is not active. Displaying normally.`);
      } catch { /* ignore */ }
      return { routed: false };
    }
    return await executeRoute(thread, state, sourceAgent, targetAgent, routeContent, isFallback, routingCount, legacyTarget, onBeforeSend);
  }

  if (!routeTarget.isAvailable()) {
    try {
      await thread.send(`⚠️ @${targetAgent} session is not active. Displaying normally.`);
    } catch { /* ignore */ }
    return { routed: false };
  }

  return await executeRoute(thread, state, sourceAgent, targetAgent, routeContent, isFallback, routingCount, routeTarget, onBeforeSend);
}

async function executeRoute(
  thread: ThreadChannel,
  state: DiscordState,
  sourceAgent: string,
  targetAgent: string,
  routeContent: string,
  isFallback: boolean,
  routingCount: number,
  routeTarget: AgentRouteTarget,
  onBeforeSend?: (content: string) => void,
): Promise<RouteResult> {
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

  const sent = await Promise.resolve(routeTarget.send(messageForTarget));
  if (!sent) {
    try {
      await thread.send(`⚠️ ${targetLabel} is busy or session ended. Message was not delivered.`);
    } catch { /* ignore */ }
  }

  state.lastActiveAgent.set(thread.id, targetAgent);
  return { routed: true };
}
