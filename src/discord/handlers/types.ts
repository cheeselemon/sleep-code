/**
 * Shared types for session handlers
 */

import type { Client } from 'discord.js';
import type { ChannelManager } from '../channel-manager.js';
import type { ProcessManager } from '../process-manager.js';
import type { DiscordState } from '../state.js';
import type { CodexSessionManager } from '../codex/codex-session-manager.js';
import type { MemoryCollector } from '../../memory/memory-collector.js';

export interface HandlerContext {
  client: Client;
  channelManager: ChannelManager;
  processManager?: ProcessManager;
  codexSessionManager?: CodexSessionManager;
  state: DiscordState;
  memoryCollector?: MemoryCollector;
}
