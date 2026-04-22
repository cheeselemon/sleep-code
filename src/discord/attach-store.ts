import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
} from 'discord.js';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { discordLogger as log } from '../utils/logger.js';

export const ATTACH_BUTTON_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface AttachButtonRecord {
  sessionId: string;
  threadId: string;
  messageId: string;
  filePath: string;
  cwd: string;
  renderedAt: string;
  uploadedMessageUrl: string | null;
}

function truncateLabel(label: string, max = 80): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 3)}...`;
}

function buildAttachLabel(filePath: string, expired = false): string {
  const label = `📎 ${basename(filePath)}${expired ? ' (만료)' : ''}`;
  return truncateLabel(label);
}

function buildButtonRow(entries: Array<{ customId: string; filePath: string }>, expired: boolean) {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const entry of entries.slice(0, 5)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(entry.customId)
        .setLabel(buildAttachLabel(entry.filePath, expired))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(expired),
    );
  }
  return row;
}

export class AttachStore {
  private readonly records = new Map<string, AttachButtonRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly filePath = join(homedir(), '.sleep-code', 'attach-buttons.json'),
  ) {}

  get(customId: string): AttachButtonRecord | undefined {
    return this.records.get(customId);
  }

  async registerButtons(
    client: Client,
    buttons: Array<{
      customId: string;
      sessionId: string;
      threadId: string;
      messageId: string;
      filePath: string;
      cwd: string;
    }>,
  ): Promise<void> {
    const renderedAt = new Date().toISOString();
    for (const button of buttons) {
      this.records.set(button.customId, {
        ...button,
        renderedAt,
        uploadedMessageUrl: null,
      });
      this.scheduleExpiry(client, button.customId);
    }
    await this.save();
  }

  async markUploaded(customId: string, uploadedMessageUrl: string): Promise<void> {
    const record = this.records.get(customId);
    if (!record) return;
    record.uploadedMessageUrl = uploadedMessageUrl;
    await this.save();
  }

  async load(client: Client): Promise<void> {
    let parsed: Record<string, AttachButtonRecord>;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      parsed = JSON.parse(raw) as Record<string, AttachButtonRecord>;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        log.error({ err }, 'Failed to load attach button state');
      }
      return;
    }

    for (const [customId, record] of Object.entries(parsed)) {
      this.records.set(customId, record);
    }

    log.info({ count: this.records.size }, 'Loaded persisted attach buttons');

    for (const customId of Array.from(this.records.keys())) {
      const record = this.records.get(customId);
      if (!record) continue;
      const expiresAt = Date.parse(record.renderedAt) + ATTACH_BUTTON_TTL_MS;
      if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
        await this.expireMessage(client, record.messageId);
        continue;
      }
      this.scheduleExpiry(client, customId);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private scheduleExpiry(client: Client, customId: string): void {
    const record = this.records.get(customId);
    if (!record) return;

    const existingTimer = this.timers.get(customId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const delay = Math.max(0, Date.parse(record.renderedAt) + ATTACH_BUTTON_TTL_MS - Date.now());
    const timer = setTimeout(() => {
      this.expireMessage(client, record.messageId).catch(err => {
        log.warn({ err, messageId: record.messageId }, 'Failed to expire attach buttons');
      });
    }, delay);
    this.timers.set(customId, timer);
  }

  async expireMessage(client: Client, messageId: string): Promise<void> {
    const entries = this.getEntriesForMessage(messageId);
    if (entries.length === 0) return;

    const threadId = entries[0].record.threadId;
    try {
      const channel = await client.channels.fetch(threadId);
      if (channel?.isThread()) {
        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (message) {
          const row = buildButtonRow(entries.map(entry => ({
            customId: entry.customId,
            filePath: entry.record.filePath,
          })), true);
          await message.edit({ components: [row] });
        }
      }
    } catch (err) {
      log.warn({ err, messageId, threadId }, 'Failed to edit expired attach button message');
    } finally {
      for (const entry of entries) {
        const timer = this.timers.get(entry.customId);
        if (timer) clearTimeout(timer);
        this.timers.delete(entry.customId);
        this.records.delete(entry.customId);
      }
      await this.save();
    }
  }

  private getEntriesForMessage(messageId: string) {
    return Array.from(this.records.entries())
      .filter(([, record]) => record.messageId === messageId)
      .map(([customId, record]) => ({ customId, record }));
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const payload = Object.fromEntries(this.records.entries());
      await writeFile(this.filePath, JSON.stringify(payload, null, 2));
    } catch (err) {
      log.error({ err }, 'Failed to save attach button state');
    }
  }
}
