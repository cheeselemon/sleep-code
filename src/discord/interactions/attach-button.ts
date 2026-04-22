import { AttachmentBuilder, type ButtonInteraction } from 'discord.js';
import { basename } from 'path';
import { ATTACH_BUTTON_TTL_MS } from '../attach-store.js';
import {
  DISCORD_ATTACHMENT_SIZE_LIMIT,
  formatAttachmentSizeMB,
  validateAttachmentPath,
} from '../utils.js';
import type { ButtonHandler } from './types.js';

function expired(recordRenderedAt: string): boolean {
  return Date.now() >= Date.parse(recordRenderedAt) + ATTACH_BUTTON_TTL_MS;
}

export const handleAttachButton: ButtonHandler = async (interaction, context) => {
  const attachStore = context.attachStore;
  if (!attachStore) {
    await interaction.reply({ content: '❌ Attach button store is not available.', ephemeral: true });
    return;
  }

  const record = attachStore.get(interaction.customId);
  if (!record) {
    await interaction.reply({ content: '⚠️ 이 첨부 버튼은 만료되었거나 더 이상 사용할 수 없습니다.', ephemeral: true });
    return;
  }

  if (expired(record.renderedAt)) {
    await attachStore.expireMessage(interaction.client, record.messageId);
    await interaction.reply({ content: '⚠️ 이 첨부 버튼은 만료되었습니다.', ephemeral: true });
    return;
  }

  if (record.uploadedMessageUrl) {
    await interaction.reply({
      content: `📎 이미 이 메시지에 첨부되어 있습니다: ${record.uploadedMessageUrl}`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const validation = validateAttachmentPath(record.filePath, record.cwd, { requireExists: true });
  if (!validation.ok) {
    if (validation.error === 'missing') {
      await interaction.editReply('⚠️ 파일이 더 이상 존재하지 않습니다.');
      return;
    }
    if (validation.error === 'outside_cwd' || validation.error === 'not_absolute') {
      await interaction.editReply('⚠️ 세션 디렉토리 밖 경로는 허용되지 않습니다.');
      return;
    }
    await interaction.editReply('⚠️ 파일을 검증하지 못했습니다.');
    return;
  }

  const size = validation.size ?? 0;
  if (size > DISCORD_ATTACHMENT_SIZE_LIMIT) {
    await interaction.editReply(
      `⚠️ 파일 크기 ${formatAttachmentSizeMB(size)}MB > 25MB 제한`,
    );
    return;
  }

  try {
    const channel = await interaction.client.channels.fetch(record.threadId);
    if (!channel?.isThread()) {
      await interaction.editReply('⚠️ 첨부를 업로드할 스레드를 찾지 못했습니다.');
      return;
    }

    const attachment = new AttachmentBuilder(validation.realPath ?? validation.normalizedPath ?? record.filePath, {
      name: basename(record.filePath),
    });
    const uploadMessage = await channel.send({
      content: `📎 **첨부 파일**: \`${basename(record.filePath)}\``,
      files: [attachment],
    });

    await attachStore.markUploaded(interaction.customId, uploadMessage.url);
    await interaction.editReply(`✅ 첨부했습니다: ${uploadMessage.url}`);
  } catch (err) {
    await interaction.editReply('❌ 파일 업로드에 실패했습니다.');
  }
};
