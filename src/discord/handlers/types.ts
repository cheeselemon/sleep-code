/**
 * Shared types for session handlers
 */

import type { Client } from 'discord.js';
import type { ChannelManager } from '../channel-manager.js';
import type { ProcessManager } from '../process-manager.js';
import type { DiscordState } from '../state.js';

export interface HandlerContext {
  client: Client;
  channelManager: ChannelManager;
  processManager?: ProcessManager;
  state: DiscordState;
}
