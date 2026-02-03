/**
 * Permission button handlers (perm:*)
 */

import { discordLogger as log } from '../../utils/logger.js';
import type { ButtonHandler } from './types.js';

/**
 * Handle permission request buttons (allow/deny/yolo)
 */
export const handlePermissionButton: ButtonHandler = async (interaction, context) => {
  const { state } = context;
  const customId = interaction.customId;

  // Immediately defer to prevent 3-second timeout
  await interaction.deferUpdate();

  const parts = customId.split(':');
  if (parts.length !== 3) return;

  const [, requestId, decision] = parts;
  const pending = state.pendingPermissions.get(requestId);
  if (!pending) {
    try {
      await interaction.editReply({ content: '⚠️ This permission request has expired.', components: [] });
    } catch (err) {
      log.warn({ err }, 'Failed to edit reply for expired permission');
    }
    return;
  }

  // 'allow' and 'yolo' both grant permission, 'deny' rejects
  const behavior = (decision === 'allow' || decision === 'yolo') ? 'allow' : 'deny';
  pending.resolve({ behavior });
  state.pendingPermissions.delete(requestId);

  let emoji: string;
  let statusText: string;
  if (decision === 'allow') {
    emoji = '✅';
    statusText = 'Permission granted';
  } else if (decision === 'yolo') {
    emoji = '🔥';
    statusText = 'Permission granted + YOLO mode ON';
    // Enable YOLO mode for this session
    state.yoloSessions.add(pending.sessionId);
  } else {
    emoji = '❌';
    statusText = 'Permission denied';
  }

  try {
    await interaction.editReply({
      content: `${emoji} ${statusText}`,
      components: [],
    });
  } catch (err) {
    log.warn({ err }, 'Failed to edit reply for permission (may have timed out)');
  }
};
