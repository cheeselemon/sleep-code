/**
 * Daily Digest Runner
 *
 * Generates periodic memory digests at scheduled times (e.g., 10:00, 16:00 KST).
 * Queries MemoryService for open tasks and recent high-priority memories,
 * then uses Claude SDK to generate a brief summary.
 */

import { logger } from '../utils/logger.js';
import { type MemoryService } from './memory-service.js';
import { ChatService, ClaudeSdkChatProvider } from './chat-provider.js';
import { getMemoryConfig, onConfigChange, type MemoryConfig } from './memory-config.js';

const log = logger.child({ component: 'daily-digest' });

// ── Types ────────────────────────────────────────────────────

export interface DigestResult {
  generatedAt: string;
  summary: string;
  openTasks: number;
  recentDecisions: number;
  topTopics: string[];
}

export interface DigestEvents {
  onDigestReady: (digest: DigestResult) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}

// ── Runner ───────────────────────────────────────────────────

export class DailyDigestRunner {
  private memory: MemoryService;
  private events: DigestEvents;
  private checkTimer: NodeJS.Timeout | null = null;
  private running = false;

  // Prevent duplicate sends: "HH:MM" → "YYYY-MM-DD"
  private lastDigestDate = new Map<string, string>();

  // Config
  private schedule: string[] = [];
  private timezone: string = 'Asia/Seoul';
  private model: string = 'sonnet';
  private enabled: boolean = true;

  private configUnsubscribe: (() => void) | null = null;

  constructor(memory: MemoryService, events: DigestEvents) {
    this.memory = memory;
    this.events = events;

    const config = getMemoryConfig();
    this.applyConfig(config);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.configUnsubscribe = onConfigChange((config) => {
      this.applyConfig(config);
    });

    if (!this.enabled) {
      log.info('Daily digest started (disabled — waiting for config change)');
      return;
    }

    this.startTimer();
    log.info({ schedule: this.schedule, timezone: this.timezone, model: this.model }, 'Daily digest started');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopTimer();
    this.configUnsubscribe?.();
    this.configUnsubscribe = null;
    log.info('Daily digest stopped');
  }

  /** Generate a digest on demand (for testing or manual trigger) */
  async generateDigest(): Promise<DigestResult> {
    const projects = await this.memory.listProjects();

    // Collect open tasks
    const allTasks: { text: string; project: string; priority: number; topicKey: string }[] = [];
    const recentDecisions: { text: string; project: string; priority: number }[] = [];
    const topicCounts = new Map<string, number>();

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    for (const project of projects) {
      const items = await this.memory.getByProject(project, { limit: 500 });

      for (const item of items) {
        // Open tasks
        if (item.kind === 'task' && item.status === 'open') {
          allTasks.push({
            text: item.text,
            project,
            priority: item.priority,
            topicKey: item.topicKey || '',
          });
        }

        // Recent high-priority decisions (last 24h, priority >= 5)
        if (
          item.kind === 'decision' &&
          item.priority >= 5 &&
          item.createdAt && item.createdAt >= oneDayAgo
        ) {
          recentDecisions.push({ text: item.text, project, priority: item.priority });
        }

        // Topic frequency (recent items only)
        if (item.createdAt && item.createdAt >= oneDayAgo && item.topicKey) {
          topicCounts.set(item.topicKey, (topicCounts.get(item.topicKey) || 0) + 1);
        }
      }
    }

    // Sort tasks by priority desc
    allTasks.sort((a, b) => b.priority - a.priority);
    recentDecisions.sort((a, b) => b.priority - a.priority);

    // Top 5 active topics
    const topTopics = Array.from(topicCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic);

    // Build LLM prompt
    const taskList = allTasks.slice(0, 15).map(
      (t) => `- [${t.project}] (p:${t.priority}) ${t.text}`
    ).join('\n') || '(없음)';

    const decisionList = recentDecisions.slice(0, 10).map(
      (d) => `- [${d.project}] (p:${d.priority}) ${d.text}`
    ).join('\n') || '(없음)';

    const topicList = topTopics.length > 0
      ? topTopics.join(', ')
      : '(없음)';

    const prompt = `You are a personal assistant generating a daily briefing.

Open tasks (${allTasks.length} total, showing top ${Math.min(15, allTasks.length)}):
${taskList}

Recent decisions (last 24h, ${recentDecisions.length} total):
${decisionList}

Active topics: ${topicList}

Generate a brief Korean daily briefing. Format:

📋 **할 일** (top priority tasks)
📌 **주요 결정/변경** (recent decisions, only if any)
🔥 **활발한 주제** (active topics)

Rules:
- Max 500 chars total
- Prioritize actionable items
- Skip sections if empty
- Be concise, not chatty`;

    let summary: string;
    try {
      const chatProvider = new ClaudeSdkChatProvider({ model: this.model });
      const chatService = new ChatService(chatProvider);
      summary = await chatService.chat([
        { role: 'user', content: prompt },
      ]);
      await chatProvider.closeSession();
    } catch (err) {
      log.error({ err }, 'Failed to generate digest with LLM');
      // Fallback: simple list
      summary = `📋 **할 일** (${allTasks.length}건)\n`;
      for (const t of allTasks.slice(0, 5)) {
        summary += `- ${t.text}\n`;
      }
      if (recentDecisions.length > 0) {
        summary += `\n📌 **최근 결정** (${recentDecisions.length}건)\n`;
        for (const d of recentDecisions.slice(0, 3)) {
          summary += `- ${d.text}\n`;
        }
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      summary,
      openTasks: allTasks.length,
      recentDecisions: recentDecisions.length,
      topTopics,
    };
  }

  // ── Internal ────────────────────────────────────────────────

  private startTimer(): void {
    this.stopTimer();
    // Check every 60 seconds against schedule
    this.checkTimer = setInterval(() => {
      this.checkSchedule().catch((err) => {
        log.error({ err }, 'Schedule check failed');
      });
    }, 60_000);
  }

  private stopTimer(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  private async checkSchedule(): Promise<void> {
    if (!this.enabled || !this.running) return;

    const now = new Date();
    const currentTime = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: this.timezone,
    }); // "HH:MM"
    const currentDate = now.toLocaleDateString('sv-SE', { timeZone: this.timezone }); // "YYYY-MM-DD"

    for (const scheduled of this.schedule) {
      if (currentTime !== scheduled) continue;

      // Already sent for this time today?
      if (this.lastDigestDate.get(scheduled) === currentDate) continue;

      // Mark as sent before generating (prevent double-fire)
      this.lastDigestDate.set(scheduled, currentDate);

      log.info({ time: scheduled }, 'Generating scheduled digest');

      try {
        const digest = await this.generateDigest();
        await this.events.onDigestReady(digest);
        log.info({ time: scheduled, tasks: digest.openTasks, decisions: digest.recentDecisions }, 'Digest delivered');
      } catch (err) {
        log.error({ err, time: scheduled }, 'Failed to generate/deliver digest');
        await this.events.onError?.(err as Error);
      }
    }
  }

  private applyConfig(config: MemoryConfig): void {
    const d = config.digest;
    const wasEnabled = this.enabled;

    this.schedule = d.schedule;
    this.timezone = d.timezone;
    this.model = d.model;
    this.enabled = d.enabled;

    if (this.running) {
      if (d.enabled && !wasEnabled) {
        this.startTimer();
        log.info({ schedule: this.schedule }, 'Daily digest enabled');
      } else if (!d.enabled && wasEnabled) {
        this.stopTimer();
        log.info('Daily digest disabled');
      }
    }
  }
}
