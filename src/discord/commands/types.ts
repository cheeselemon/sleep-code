/**
 * Shared types for command handlers
 */

import type { Client, ChatInputCommandInteraction } from 'discord.js';
import type { ChannelManager } from '../channel-manager.js';
import type { ProcessManager } from '../process-manager.js';
import type { SettingsManager } from '../settings-manager.js';
import type { SessionManager } from '../../slack/session-manager.js';
import type { DiscordState } from '../state.js';

export interface CommandContext {
  client: Client;
  channelManager: ChannelManager;
  sessionManager: SessionManager;
  processManager?: ProcessManager;
  settingsManager?: SettingsManager;
  state: DiscordState;
}

export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  context: CommandContext
) => Promise<void>;
