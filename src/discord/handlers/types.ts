/**
 * Shared types for session handlers
 */

import type { Client } from 'discord.js';
import type { ChannelManager } from '../channel-manager.js';
import type { ProcessManager } from '../process-manager.js';
import type { DiscordState } from '../state.js';
import type { CodexSessionManager } from '../codex/codex-session-manager.js';
import type { ClaudeSdkSessionManager } from '../claude-sdk/claude-sdk-session-manager.js';
import type { AgentSessionManager } from '../agents/agent-session-manager.js';
import type { MemoryCollector } from '../../memory/memory-collector.js';

export interface HandlerContext {
  client: Client;
  channelManager: ChannelManager;
  processManager?: ProcessManager;
  codexSessionManager?: CodexSessionManager;
  claudeSdkSessionManager?: ClaudeSdkSessionManager;
  agentSessionManagerRef?: { current: AgentSessionManager | undefined };
  state: DiscordState;
  memoryCollector?: MemoryCollector;
}
