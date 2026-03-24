/**
 * Shared types for interaction handlers
 */

import type {
  Client,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import type { ChannelManager } from '../channel-manager.js';
import type { ProcessManager } from '../process-manager.js';
import type { SettingsManager } from '../settings-manager.js';
import type { SessionManager } from '../../shared/session-manager.js';
import type { DiscordState } from '../state.js';
import type { CodexSessionManager } from '../codex/codex-session-manager.js';
import type { ClaudeSdkSessionManager } from '../claude-sdk/claude-sdk-session-manager.js';
import type { MemoryService } from '../../memory/memory-service.js';

export interface InteractionContext {
  client: Client;
  channelManager: ChannelManager;
  sessionManager: SessionManager;
  processManager?: ProcessManager;
  settingsManager?: SettingsManager;
  codexSessionManager?: CodexSessionManager;
  claudeSdkSessionManager?: ClaudeSdkSessionManager;
  memoryService?: MemoryService;
  state: DiscordState;
}

export type ButtonHandler = (
  interaction: ButtonInteraction,
  context: InteractionContext
) => Promise<void>;

export type SelectMenuHandler = (
  interaction: StringSelectMenuInteraction,
  context: InteractionContext
) => Promise<void>;

export type ModalHandler = (
  interaction: ModalSubmitInteraction,
  context: InteractionContext
) => Promise<void>;
