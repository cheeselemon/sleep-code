/**
 * /settings command handler
 * Shows current settings with example prompts to change them
 */

import { EmbedBuilder } from 'discord.js';
import type { CommandHandler } from './types.js';

export const handleSettings: CommandHandler = async (interaction, context) => {
  const { settingsManager, state } = context;

  if (!settingsManager) {
    await interaction.reply({ content: '⚠️ Settings manager not available.', ephemeral: true });
    return;
  }

  const dirs = settingsManager.getAllowedDirectories();
  const terminal = settingsManager.getTerminalApp();
  const maxSessions = settingsManager.getMaxSessions();
  const autoCleanup = settingsManager.shouldAutoCleanupOrphans();
  const yoloCount = state.yoloSessions.size;

  const dirList = dirs.length > 0
    ? dirs.map(d => `\`${d}\``).join('\n')
    : '_없음_';

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Sleep Code Settings')
    .setColor(0x5865F2)
    .addFields(
      {
        name: '📁 Allowed Directories',
        value: `${dirList}\n` +
          `> 💬 _"~/new-project 디렉토리 추가해줘"_\n` +
          `> 💬 _"/claude add-dir /path/to/dir"_`,
      },
      {
        name: '🖥️ Terminal App',
        value: `\`${terminal}\`\n` +
          `> 💬 _"터미널 iTerm2로 바꿔줘"_\n` +
          `> 💬 _"/claude set-terminal"_`,
        inline: true,
      },
      {
        name: '🔢 Max Concurrent Sessions',
        value: `\`${maxSessions ?? 'unlimited'}\`\n` +
          `> 💬 _"동시 세션 3개로 제한해줘"_`,
        inline: true,
      },
      {
        name: '🧹 Auto Cleanup Orphans',
        value: `\`${autoCleanup}\`\n` +
          `> 💬 _"고아 세션 자동 정리 꺼줘"_`,
        inline: true,
      },
      {
        name: '🔥 YOLO Sessions',
        value: `\`${yoloCount}\` active\n` +
          `> 💬 _"/yolo-sleep 으로 토글"_`,
        inline: true,
      },
    )
    .setFooter({ text: '설정을 바꾸려면 💬 예시처럼 Claude에게 말하거나 슬래시 커맨드를 사용하세요' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
};
