/**
 * Restore / Dismiss button handlers for session recovery after reboot
 */

import type { ButtonInteraction } from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import type { InteractionContext } from './types.js';

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
