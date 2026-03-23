/**
 * Memory Reporter
 *
 * Manages the #sleep-code-memory Discord channel and posts batch distill results
 * into daily threads. Also handles consolidation reports.
 */

import {
  type Client,
  type TextChannel,
  type Guild,
  type ThreadChannel,
} from 'discord.js';
import { discordLogger as log } from '../utils/logger.js';
import type { BatchResult } from '../memory/batch-distill-runner.js';
import { getMemoryConfig } from '../memory/memory-config.js';

// ── Constants ────────────────────────────────────────────────

const CHANNEL_NAME = 'sleep-code-memory';
const CATEGORY_NAME = 'Sleep Code Sessions';

// ── Reporter ─────────────────────────────────────────────────

export class MemoryReporter {
  private client: Client;
  private userId: string;
  private channel: TextChannel | null = null;
  private dailyThread: ThreadChannel | null = null;
  private dailyThreadDate: string | null = null; // YYYY-MM-DD

  constructor(client: Client, userId: string) {
    this.client = client;
    this.userId = userId;
  }

  /**
   * Initialize: find or create #sleep-code-memory channel.
   * Call this after the bot is ready and guilds are cached.
   */
  async initialize(): Promise<void> {
    const guild = this.client.guilds.cache.first();
    if (!guild) {
      log.warn('No guild found — cannot create memory channel');
      return;
    }

    this.channel = await this.findOrCreateChannel(guild);
    if (this.channel) {
      log.info({ channelId: this.channel.id }, 'Memory reporter initialized');
    }
  }

  /**
   * Post a batch distill result to the daily thread.
   */
  async postBatchResult(result: BatchResult): Promise<void> {
    if (!this.channel) return;

    try {
      const thread = await this.ensureDailyThread();
      if (!thread) return;

      const message = this.formatBatchResult(result);
      await thread.send(message);
    } catch (err) {
      log.error({ err }, 'Failed to post batch result');
    }
  }

  /**
   * Post a system notification to the channel (not a thread).
   */
  async postNotification(text: string): Promise<void> {
    if (!this.channel) return;
    try {
      await this.channel.send(text);
    } catch (err) {
      log.error({ err }, 'Failed to post notification');
    }
  }

  /**
   * Post a consolidation report to a weekly thread.
   */
  async postConsolidationReport(report: string): Promise<void> {
    if (!this.channel) return;
    try {
      const thread = await this.ensureConsolidationThread();
      if (!thread) return;
      await thread.send(report);
    } catch (err) {
      log.error({ err }, 'Failed to post consolidation report');
    }
  }

  /** Get the memory channel (for external use) */
  getChannel(): TextChannel | null {
    return this.channel;
  }

  // ── Channel / Thread Management ─────────────────────────────

  private async findOrCreateChannel(guild: Guild): Promise<TextChannel | null> {
    // discord.js ChannelType enum values
    const GuildText = 0;
    const GuildCategory = 4;

    // Find existing channel
    const existing = guild.channels.cache.find(
      (ch) => ch.name === CHANNEL_NAME && ch.type === GuildText,
    ) as TextChannel | undefined;

    if (existing) return existing;

    // Find or create category
    let categoryId: string | undefined;
    const existingCategory = guild.channels.cache.find(
      (ch) => ch.name === CATEGORY_NAME && ch.type === GuildCategory,
    );

    if (existingCategory) {
      categoryId = existingCategory.id;
    } else {
      try {
        const created = await guild.channels.create({
          name: CATEGORY_NAME,
          type: GuildCategory as any,
        });
        categoryId = created.id;
      } catch (err) {
        log.warn({ err }, 'Failed to create category, creating channel without category');
      }
    }

    // Create channel
    try {
      const channel = await guild.channels.create({
        name: CHANNEL_NAME,
        type: GuildText as any,
        parent: categoryId,
        topic: 'Memory distill & consolidation reports',
      }) as unknown as TextChannel;

      await channel.send(
        '🧠 **Memory System Initialized**\n' +
        'Batch distill results and consolidation reports will appear here.\n' +
        'Use `/memory opt-out` in a session thread to disable collection for that session.\n' +
        'Use `/memory opt-out --global` to disable the entire memory system.',
      );

      return channel;
    } catch (err) {
      log.error({ err }, 'Failed to create memory channel');
      return null;
    }
  }

  private async ensureDailyThread(): Promise<ThreadChannel | null> {
    if (!this.channel) return null;

    const today = this.getToday();

    // Reuse existing thread for today
    if (this.dailyThread && this.dailyThreadDate === today) {
      // Verify thread is still accessible
      try {
        if (!this.dailyThread.archived) return this.dailyThread;
        // Unarchive if needed
        await this.dailyThread.setArchived(false);
        return this.dailyThread;
      } catch {
        // Thread gone — recreate
        this.dailyThread = null;
        this.dailyThreadDate = null;
      }
    }

    // Search for existing thread with today's name
    const threadName = `distill-${today}`;

    try {
      // Check active threads first
      const activeThreads = await this.channel.threads.fetchActive();
      const found = activeThreads.threads.find((t) => t.name === threadName);
      if (found) {
        this.dailyThread = found;
        this.dailyThreadDate = today;
        return found;
      }

      // Check archived threads (recent)
      const archivedThreads = await this.channel.threads.fetchArchived({ limit: 10 });
      const archived = archivedThreads.threads.find((t) => t.name === threadName);
      if (archived) {
        await archived.setArchived(false);
        this.dailyThread = archived;
        this.dailyThreadDate = today;
        return archived;
      }
    } catch (err) {
      log.debug({ err }, 'Failed to search for existing thread');
    }

    // Create new daily thread
    try {
      const thread = await this.channel.threads.create({
        name: threadName,
        autoArchiveDuration: 1440, // 24 hours auto-archive
        reason: `Daily distill thread for ${today}`,
      });

      if (this.userId) {
        await thread.members.add(this.userId).catch(() => {});
      }

      this.dailyThread = thread;
      this.dailyThreadDate = today;
      return thread;
    } catch (err) {
      log.error({ err }, 'Failed to create daily thread');
      return null;
    }
  }

  private async ensureConsolidationThread(): Promise<ThreadChannel | null> {
    if (!this.channel) return null;

    const weekStr = this.getWeekString();
    const threadName = `consolidation-${weekStr}`;

    try {
      // Check active threads
      const activeThreads = await this.channel.threads.fetchActive();
      const found = activeThreads.threads.find((t) => t.name === threadName);
      if (found) return found;

      // Create new
      const thread = await this.channel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080, // 7 days
        reason: `Weekly consolidation thread for ${weekStr}`,
      });
      if (this.userId) {
        await thread.members.add(this.userId).catch(() => {});
      }
      return thread;
    } catch (err) {
      log.error({ err }, 'Failed to create consolidation thread');
      return null;
    }
  }

  // ── Formatting ──────────────────────────────────────────────

  private formatBatchResult(result: BatchResult): string {
    const time = new Date(result.timestamp).toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Seoul',
    });

    const config = getMemoryConfig();
    const lines: string[] = [];

    // Batch header
    lines.push(`── **Batch #${result.batchNumber}** (${time}) ──`);

    // Stored items
    const storedItems = result.items.filter((i) => i.action === 'stored');
    for (const item of storedItems) {
      lines.push(`🟢 **STORED** [${item.kind} p:${item.priority}] "${item.distilled}"`);
    }

    // Superseded items
    const supersededItems = result.items.filter((i) => i.action === 'superseded');
    for (const item of supersededItems) {
      const oldRef = item.oldMemoryId ? ` (replaces \`${item.oldMemoryId.slice(0, 8)}\`)` : '';
      lines.push(`🔄 **SUPERSEDE** [${item.kind} p:${item.priority}] "${item.distilled}"${oldRef}`);
    }

    // Error items
    const errorItems = result.items.filter((i) => i.action === 'error');
    for (const item of errorItems) {
      lines.push(`❌ **ERROR** ${item.error}`);
    }

    // Skip summary
    if (config.distill.skipVerbosity === 'count') {
      if (result.skipped > 0) {
        lines.push(`⏭️ ${result.skipped}건 스킵`);
      }
    } else {
      // 'list' mode - show each skipped item (not implemented for now, use count)
      if (result.skipped > 0) {
        lines.push(`⏭️ ${result.skipped}건 스킵`);
      }
    }

    // Summary line
    lines.push(
      `📊 ${result.totalProcessed} processed → ` +
      `${result.stored} stored, ${result.superseded} superseded, ` +
      `${result.skipped} skipped` +
      (result.errors > 0 ? `, ${result.errors} errors` : ''),
    );

    return lines.join('\n');
  }

  // ── Helpers ─────────────────────────────────────────────────

  private getToday(): string {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD
  }

  private getWeekString(): string {
    const now = new Date();
    const year = now.getFullYear();
    // ISO week number
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${year}-W${String(weekNo).padStart(2, '0')}`;
  }
}
