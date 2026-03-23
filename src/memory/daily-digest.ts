/**
 * Daily Digest Runner
 *
 * Generates periodic memory digests at scheduled times (e.g., 10:00, 16:00 KST).
 * Queries MemoryService for open tasks and recent high-priority memories,
 * then uses Claude SDK to generate a brief summary.
 *
 * Custom prompt: place a template file at ~/.sleep-code/digest-prompt.txt
 * Available variables: {{OPEN_TASKS}}, {{RECENT_DECISIONS}}, {{ACTIVE_TOPICS}},
 *                      {{TASK_COUNT}}, {{DECISION_COUNT}}
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { type MemoryService } from './memory-service.js';
import { ChatService, ClaudeSdkChatProvider } from './chat-provider.js';
import { getMemoryConfig, onConfigChange, type MemoryConfig } from './memory-config.js';

const log = logger.child({ component: 'daily-digest' });

// ── Prompt Template ─────────────────────────────────────────

const CUSTOM_PROMPT_PATH = join(homedir(), '.sleep-code', 'digest-prompt.txt');

const DEFAULT_DIGEST_PROMPT = `You are a personal assistant generating a daily briefing for a developer.

Open tasks ({{TASK_COUNT}} total):
{{OPEN_TASKS}}

Recent decisions (last 24h, {{DECISION_COUNT}} total):
{{RECENT_DECISIONS}}

Active topics: {{ACTIVE_TOPICS}}

Generate a concise daily briefing. Format:

📋 **To Do** (top priority tasks)
📌 **Key Decisions** (recent decisions, only if any)
🔥 **Active Topics** (active topics)

Rules:
- Max 500 chars total
- Prioritize actionable items
- Skip sections if empty
- Be concise, not chatty
- Write in the user's language if detectable from the data, otherwise English`;

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

    // Build template variables
    const taskList = allTasks.slice(0, 15).map(
      (t) => `- [${t.project}] (p:${t.priority}) ${t.text}`
    ).join('\n') || '(none)';

    const decisionList = recentDecisions.slice(0, 10).map(
      (d) => `- [${d.project}] (p:${d.priority}) ${d.text}`
    ).join('\n') || '(none)';

    const topicList = topTopics.length > 0
      ? topTopics.join(', ')
      : '(none)';

    // Load and fill prompt template
    const template = await this.loadPromptTemplate();
    const prompt = template
      .replace(/\{\{OPEN_TASKS\}\}/g, taskList)
      .replace(/\{\{RECENT_DECISIONS\}\}/g, decisionList)
      .replace(/\{\{ACTIVE_TOPICS\}\}/g, topicList)
      .replace(/\{\{TASK_COUNT\}\}/g, String(allTasks.length))
      .replace(/\{\{DECISION_COUNT\}\}/g, String(recentDecisions.length));

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
      // Fallback: simple list without LLM
      summary = `📋 **To Do** (${allTasks.length})\n`;
      for (const t of allTasks.slice(0, 5)) {
        summary += `- ${t.text}\n`;
      }
      if (recentDecisions.length > 0) {
        summary += `\n📌 **Key Decisions** (${recentDecisions.length})\n`;
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

  /** Load custom prompt template from file, or use default */
  private async loadPromptTemplate(): Promise<string> {
    try {
      if (existsSync(CUSTOM_PROMPT_PATH)) {
        const custom = await readFile(CUSTOM_PROMPT_PATH, 'utf-8');
        if (custom.trim()) {
          log.info('Using custom digest prompt from digest-prompt.txt');
          return custom;
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load custom digest prompt, using default');
    }
    return DEFAULT_DIGEST_PROMPT;
  }

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
