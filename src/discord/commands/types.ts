/**
 * Shared types for command handlers
 */

import type { Client, ChatInputCommandInteraction } from 'discord.js';
import type { ChannelManager } from '../channel-manager.js';
import type { ProcessManager } from '../process-manager.js';
import type { SettingsManager } from '../settings-manager.js';
import type { SessionManager } from '../../shared/session-manager.js';
import type { DiscordState } from '../state.js';
import type { CodexSessionManager } from '../codex/codex-session-manager.js';
import type { ClaudeSdkSessionManager } from '../claude-sdk/claude-sdk-session-manager.js';
import type { MemoryService } from '../../memory/memory-service.js';
import type { MemoryAuthorityClient } from '../../memory/memory-authority-client.js';

export interface CommandContext {
  client: Client;
  channelManager: ChannelManager;
  sessionManager: SessionManager;
  processManager?: ProcessManager;
  settingsManager?: SettingsManager;
  codexSessionManager?: CodexSessionManager;
  claudeSdkSessionManager?: ClaudeSdkSessionManager;
  memoryService?: MemoryService;
  memoryClient?: MemoryAuthorityClient;
  state: DiscordState;
}

export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  context: CommandContext
) => Promise<void>;
