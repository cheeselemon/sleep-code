/**
 * Restore / Dismiss button handlers for session recovery after reboot
 */

import type { ButtonInteraction } from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import type { InteractionContext } from './types.js';
import type { ClaudeSdkSessionManager } from '../claude-sdk/claude-sdk-session-manager.js';

/**
 * Handle "Restore Session" button click
 */
export async function handleRestoreButton(
  interaction: ButtonInteraction,
  context: InteractionContext
): Promise<void> {
  const { processManager, settingsManager } = context;
  if (!processManager || !settingsManager) {
    await interaction.reply({ content: 'Process management not available.', flags: 64 });
    return;
  }

  const sessionId = interaction.customId.slice('restore:'.length);
  const entry = await processManager.getEntry(sessionId);

  if (!entry || entry.status !== 'needs_restore') {
    await interaction.update({
      content: 'This restore offer has expired or was already handled.',
      components: [],
    });
    return;
  }

  await interaction.update({
    content:
      `🔄 **Restoring session...**\n` +
      `Directory: \`${entry.cwd}\``,
    components: [],
  });

  try {
    const terminalApp = settingsManager.getTerminalApp();
    // Spawn with resume=true, reusing the same sessionId
    await processManager.spawn(entry.cwd, sessionId, terminalApp, true);

    log.info({ sessionId, cwd: entry.cwd }, 'Session restore initiated');

    await interaction.editReply({
      content:
        `✅ **Session restoring**\n` +
        `Directory: \`${entry.cwd}\`\n` +
        `Waiting for Claude to connect...`,
    });
  } catch (err) {
    log.error({ err, sessionId }, 'Failed to restore session');
    await interaction.editReply({
      content: `❌ **Failed to restore**: ${(err as Error).message}`,
    });
  }
}

/**
 * Handle "Dismiss" button click
 */
export async function handleDismissRestoreButton(
  interaction: ButtonInteraction,
  context: InteractionContext
): Promise<void> {
  const { processManager, channelManager } = context;
  if (!processManager) {
    await interaction.reply({ content: 'Process management not available.', flags: 64 });
    return;
  }

  const sessionId = interaction.customId.slice('dismiss_restore:'.length);
  const entry = await processManager.getEntry(sessionId);

  // Clean up
  await processManager.removeEntry(sessionId);
  await channelManager.removePersistedMapping(sessionId);

  await interaction.update({
    content: '🗑️ **Session dismissed** — thread will be archived.',
    components: [],
  });

  // Archive the thread
  if (entry?.threadId) {
    try {
      const ch = await interaction.client.channels.fetch(entry.threadId);
      if (ch?.isThread()) {
        await ch.setArchived(true);
      }
    } catch {
      // Thread may already be gone
    }
  }
}

/**
 * Handle "Restore SDK Session" button click
 */
export async function handleRestoreSdkButton(
  interaction: ButtonInteraction,
  context: InteractionContext
): Promise<void> {
  const claudeSdkSessionManager = context.claudeSdkSessionManager as ClaudeSdkSessionManager | undefined;
  if (!claudeSdkSessionManager) {
    await interaction.reply({ content: 'SDK session management not available.', flags: 64 });
    return;
  }

  const sessionId = interaction.customId.slice('restore_sdk:'.length);
  const { channelManager } = context;

  // Find persisted mapping
  const allPersisted = channelManager.getPersistedSdkMappings();
  const mapping = allPersisted.find(m => m.sessionId === sessionId);

  if (!mapping) {
    await interaction.update({
      content: 'This restore offer has expired or was already handled.',
      components: [],
    });
    return;
  }

  await interaction.update({
    content: `🔄 **Restoring SDK session...**\nDirectory: \`${mapping.cwd}\``,
    components: [],
  });

  try {
    // Start a new SDK session with resume
    await claudeSdkSessionManager.startSession(mapping.cwd, mapping.threadId, {
      sessionId: mapping.sessionId,
    });

    await interaction.editReply({
      content: `✅ **SDK session restored**\nDirectory: \`${mapping.cwd}\``,
    });
  } catch (err) {
    log.error({ err, sessionId }, 'Failed to restore SDK session');
    await interaction.editReply({
      content: `❌ **Failed to restore**: ${(err as Error).message}`,
    });
  }
}

/**
 * Handle "Dismiss" button for SDK session
 */
export async function handleDismissSdkButton(
  interaction: ButtonInteraction,
  context: InteractionContext
): Promise<void> {
  const { channelManager } = context;
  const sessionId = interaction.customId.slice('dismiss_sdk:'.length);

  await channelManager.archiveSdkSession(sessionId);

  await interaction.update({
    content: '🗑️ **SDK session dismissed** — thread will be archived.',
    components: [],
  });

  // Archive the thread
  try {
    const allPersisted = channelManager.getPersistedSdkMappings();
    const mapping = allPersisted.find(m => m.sessionId === sessionId);
    if (mapping) {
      const ch = await interaction.client.channels.fetch(mapping.threadId);
      if (ch?.isThread()) {
        await ch.setArchived(true);
      }
    }
  } catch {
    // Thread may be gone
  }
}
