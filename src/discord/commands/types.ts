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
import type { MemoryAuthorityClient } from '../../memory/memory-authority-client.js';
import type { AgentSessionManager } from '../agents/agent-session-manager.js';
import type { AttachStore } from '../attach-store.js';
import type { BatchDistillRunner } from '../../memory/batch-distill-runner.js';
import type { DailyDigestRunner } from '../../memory/daily-digest.js';
import type { MemoryReporter } from '../memory-reporter.js';

export interface CommandContext {
  client: Client;
  channelManager: ChannelManager;
  sessionManager: SessionManager;
  processManager?: ProcessManager;
  settingsManager?: SettingsManager;
  codexSessionManager?: CodexSessionManager;
  claudeSdkSessionManager?: ClaudeSdkSessionManager;
  agentSessionManager?: AgentSessionManager;
  memoryClient?: MemoryAuthorityClient;
  attachStore?: AttachStore;
  state: DiscordState;
  /** Memory pipeline runners — optional because they're wired in lazily after
   *  the bot is ready (see discord-app.ts ClientReady handler). `/status` and
   *  `/memory` both surface these. Kept on the base context so handlers don't
   *  need a separate extended type just to read runner status. */
  batchDistillRunner?: BatchDistillRunner;
  dailyDigestRunner?: DailyDigestRunner;
  memoryReporter?: MemoryReporter;
}

export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  context: CommandContext
) => Promise<void>;
