/**
 * Daily Digest Runner
 *
 * Generates periodic memory digests at scheduled times (e.g., 10:00, 16:00 KST).
 * Queries MemoryService for open tasks and recent high-priority memories,
 * then uses Claude SDK to generate a brief summary.
 *
 * Custom prompt: place a template file at ~/.sleep-code/digest-prompt.txt
 * Available variables: {{ACTION_REQUIRED}}, {{STALLED}}, {{FORGOTTEN}},
 *                      {{MAJOR_CHANGES}}, {{ACTIVE_TOPICS}}
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { type MemoryService } from './memory-service.js';
import { ChatService, ClaudeSdkChatProvider } from './chat-provider.js';
import { getMemoryConfig, onConfigChange, type MemoryConfig } from './memory-config.js';
import type { ConsolidationReport } from './consolidation-service.js';

const log = logger.child({ component: 'daily-digest' });

// ── Prompt Template ─────────────────────────────────────────

const CUSTOM_PROMPT_PATH = join(homedir(), '.sleep-code', 'digest-prompt.txt');

const DEFAULT_DIGEST_PROMPT = `You are a personal assistant generating a smart daily briefing for a busy developer/CEO.
Your job: surface things the human might FORGET or MISS. Not a data dump.

📋 Action Required — things that need to be done (not started yet):
{{ACTION_REQUIRED}}

⏸️ Stalled — work that was started but seems abandoned (3+ days idle):
{{STALLED}}

💭 Forgotten? — decisions/proposals discussed but never followed up:
{{FORGOTTEN}}

🔄 Major Changes — significant corrections, direction changes, supersedes (last 24h):
{{MAJOR_CHANGES}}

Active topics: {{ACTIVE_TOPICS}}

Generate a concise briefing. Rules:
- Max 600 chars total
- Skip any section that is empty or says "(none)"
- For each item, include [project] prefix and one-line summary
- Prioritize by urgency and importance
- Be direct and actionable, not descriptive
- Write in the user's language if detectable from the data, otherwise English
- Do NOT repeat raw data — synthesize and prioritize`;

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
  onPreConsolidation?: (report: ConsolidationReport) => void | Promise<void>;
}

// ── Runner ───────────────────────────────────────────────────

export class DailyDigestRunner {
  private memory: MemoryService;
  private events: DigestEvents;
  private consolidation: import('./consolidation-service.js').ConsolidationService | null = null;
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

    // Lazy-load ConsolidationService to avoid circular deps
    import('./consolidation-service.js').then(({ ConsolidationService }) => {
      this.consolidation = new ConsolidationService(memory);
    }).catch(() => {
      log.warn('Failed to load ConsolidationService — digest will skip pre-consolidation');
    });
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

  /** Run pre-consolidation (Phase 4 smart resolution etc.) and return report */
  async runPreConsolidation(): Promise<ConsolidationReport | null> {
    if (!this.consolidation) return null;
    try {
      log.info('Running pre-digest consolidation');
      const report = await this.consolidation.consolidate({ dryRun: false });
      log.info(
        { merged: report.totalMerged, cleaned: report.totalCleaned },
        'Pre-digest consolidation complete',
      );
      return report;
    } catch (err) {
      log.error({ err }, 'Pre-consolidation failed');
      return null;
    }
  }

  /** Generate a digest on demand (for testing or manual trigger) */
  async generateDigest(): Promise<DigestResult> {
    const projects = await this.memory.listProjects();

    const now = Date.now();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    type MemItem = { text: string; project: string; priority: number; topicKey: string; kind: string; createdAt: string };

    // 5 smart buckets
    const actionRequired: MemItem[] = [];  // needs to be done, not started
    const stalled: MemItem[] = [];         // started but idle 3+ days
    const forgotten: MemItem[] = [];       // discussed but no follow-up
    const majorChanges: MemItem[] = [];    // supersedes, corrections, direction changes
    const topicCounts = new Map<string, number>();

    // Track topicKeys that have recent task activity (to detect "forgotten" proposals)
    const topicsWithRecentTasks = new Set<string>();

    for (const project of projects) {
      const items = await this.memory.getByProject(project, { limit: 500 });

      // First pass: collect topicKeys with recent task activity
      for (const item of items) {
        if (item.kind === 'task' && item.createdAt && item.createdAt >= threeDaysAgo && item.topicKey) {
          topicsWithRecentTasks.add(`${project}::${item.topicKey}`);
        }
      }

      for (const item of items) {
        const entry: MemItem = {
          text: item.text,
          project,
          priority: item.priority,
          topicKey: item.topicKey || '',
          kind: item.kind,
          createdAt: item.createdAt || '',
        };

        // ── Action Required: high-priority open tasks, recent (7 days), p≥7
        if (
          item.kind === 'task' &&
          item.status === 'open' &&
          item.priority >= 7 &&
          item.createdAt && item.createdAt >= sevenDaysAgo
        ) {
          actionRequired.push(entry);
        }

        // ── Stalled: open tasks, 3-30 days old, p≥5 (started but idle)
        if (
          item.kind === 'task' &&
          item.status === 'open' &&
          item.priority >= 5 &&
          item.createdAt &&
          item.createdAt < threeDaysAgo &&
          item.createdAt >= new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
        ) {
          stalled.push(entry);
        }

        // ── Forgotten: proposals/decisions older than 3 days with no recent task in same topic
        if (
          (item.kind === 'proposal' || item.kind === 'decision') &&
          item.status === 'open' &&
          item.priority >= 5 &&
          item.createdAt &&
          item.createdAt < threeDaysAgo &&
          item.createdAt >= new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString() &&
          item.topicKey &&
          !topicsWithRecentTasks.has(`${project}::${item.topicKey}`)
        ) {
          forgotten.push(entry);
        }

        // ── Major Changes: recent supersedes or high-priority corrections (24h)
        if (
          item.createdAt && item.createdAt >= oneDayAgo && (
            // Supersede (new memory that replaced an old one)
            (item as any).supersedesId ||
            // High-priority decision/fact with update signals
            (item.kind === 'decision' && item.priority >= 8)
          )
        ) {
          majorChanges.push(entry);
        }

        // Topic frequency (recent items only)
        if (item.createdAt && item.createdAt >= oneDayAgo && item.topicKey) {
          topicCounts.set(item.topicKey, (topicCounts.get(item.topicKey) || 0) + 1);
        }
      }
    }

    // Sort each bucket by priority desc
    actionRequired.sort((a, b) => b.priority - a.priority);
    stalled.sort((a, b) => b.priority - a.priority);
    forgotten.sort((a, b) => b.priority - a.priority);
    majorChanges.sort((a, b) => b.priority - a.priority);

    // Top 5 active topics
    const topTopics = Array.from(topicCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic);

    // Format helper
    const fmt = (items: MemItem[], max: number) =>
      items.slice(0, max).map((t) => `- [${t.project}] (p:${t.priority}) ${t.text}`).join('\n') || '(none)';

    // Load and fill prompt template
    const template = await this.loadPromptTemplate();
    const prompt = template
      .replace(/\{\{ACTION_REQUIRED\}\}/g, fmt(actionRequired, 8))
      .replace(/\{\{STALLED\}\}/g, fmt(stalled, 5))
      .replace(/\{\{FORGOTTEN\}\}/g, fmt(forgotten, 5))
      .replace(/\{\{MAJOR_CHANGES\}\}/g, fmt(majorChanges, 5))
      .replace(/\{\{ACTIVE_TOPICS\}\}/g, topTopics.length > 0 ? topTopics.join(', ') : '(none)')
      // Legacy variable support for custom prompts
      .replace(/\{\{OPEN_TASKS\}\}/g, fmt(actionRequired, 8))
      .replace(/\{\{RECENT_DECISIONS\}\}/g, fmt(majorChanges, 5))
      .replace(/\{\{TASK_COUNT\}\}/g, String(actionRequired.length))
      .replace(/\{\{DECISION_COUNT\}\}/g, String(majorChanges.length));

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
      const sections: string[] = [];
      if (actionRequired.length > 0) {
        sections.push(`📋 **Action Required** (${actionRequired.length})`);
        for (const t of actionRequired.slice(0, 3)) sections.push(`- [${t.project}] ${t.text}`);
      }
      if (stalled.length > 0) {
        sections.push(`\n⏸️ **Stalled** (${stalled.length})`);
        for (const t of stalled.slice(0, 3)) sections.push(`- [${t.project}] ${t.text}`);
      }
      if (forgotten.length > 0) {
        sections.push(`\n💭 **Forgotten?** (${forgotten.length})`);
        for (const t of forgotten.slice(0, 3)) sections.push(`- [${t.project}] ${t.text}`);
      }
      summary = sections.join('\n') || 'No items to report.';
    }

    return {
      generatedAt: new Date().toISOString(),
      summary,
      openTasks: actionRequired.length,
      recentDecisions: majorChanges.length,
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
        // Pre-consolidation: clean up before generating digest
        if (this.consolidation) {
          log.info('Running pre-digest consolidation');
          const report = await this.consolidation.consolidate({ dryRun: false });
          log.info(
            { merged: report.totalMerged, cleaned: report.totalCleaned },
            'Pre-digest consolidation complete',
          );
          await this.events.onPreConsolidation?.(report);
        }

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
