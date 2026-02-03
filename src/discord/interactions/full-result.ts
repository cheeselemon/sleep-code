/**
 * Full result button handler (fullresult:*)
 */

import { AttachmentBuilder } from 'discord.js';
import type { ButtonHandler } from './types.js';

/**
 * Handle "View Full" button for truncated results
 */
export const handleFullResultButton: ButtonHandler = async (interaction, context) => {
  const { state } = context;
  const customId = interaction.customId;

  const resultId = customId.slice('fullresult:'.length);
  const fullResult = state.pendingFullResults.get(resultId);

  if (!fullResult) {
    await interaction.reply({ content: '⚠️ This result has expired.', ephemeral: true });
    return;
  }

  // Create .txt file with full content
  const buffer = Buffer.from(fullResult.content, 'utf-8');
  const attachment = new AttachmentBuilder(buffer, {
    name: `${fullResult.toolName}-result.txt`,
  });

  await interaction.reply({
    content: `📄 **Full result for ${fullResult.toolName}**`,
    files: [attachment],
  });

  // Clean up
  state.pendingFullResults.delete(resultId);

  // Remove button from original message
  try {
    await interaction.message.edit({ components: [] });
  } catch {
    // Ignore errors if message can't be edited
  }
};
