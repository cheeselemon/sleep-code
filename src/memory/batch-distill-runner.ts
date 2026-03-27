/**
 * Batch Distill Runner
 *
 * Queues incoming messages and processes them in batches using a persistent
 * Claude SDK session. Reports results via an event emitter interface so that
 * Discord (or any other transport) can display them.
 */

import { logger } from '../utils/logger.js';
import { MemoryService, type MemoryKind, type MemorySpeaker } from './memory-service.js';
import { DistillService, type BatchDistillItem, type BatchDistillResult, type SlidingMessage, type OpenTaskRef, type ExistingMemoryRef } from './distill-service.js';
import { ChatService, ClaudeSdkChatProvider } from './chat-provider.js';
import { getMemoryConfig, onConfigChange, type MemoryConfig } from './memory-config.js';
import { ConsolidationService, type ConsolidationReport } from './consolidation-service.js';

const log = logger.child({ component: 'batch-distill' });

// ── Types ────────────────────────────────────────────────────

export interface QueuedMessage {
  speaker: MemorySpeaker;
  displayName: string;
  content: string;
  channelId: string;
  threadId?: string;
  project?: string;
  timestamp: string;
  context: SlidingMessage[];
}

export interface BatchResultItem {
  action: 'stored' | 'superseded' | 'skipped' | 'resolved_task' | 'error';
  distilled?: string;
  kind?: string;
  priority?: number;
  topicKey?: string;
  oldMemoryId?: string;
  newMemoryId?: string;
  resolvedTaskIds?: string[];
  error?: string;
}

export interface BatchResult {
  batchNumber: number;
  timestamp: string;
  items: BatchResultItem[];
  totalProcessed: number;
  stored: number;
  superseded: number;
  resolved: number;
  skipped: number;
  errors: number;
}

export interface BatchDistillEvents {
  onBatchComplete: (result: BatchResult) => void | Promise<void>;
  onSessionRefresh?: () => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  onConfigChange?: (summary: string) => void | Promise<void>;
  onConsolidationComplete?: (report: ConsolidationReport) => void | Promise<void>;
}

// ── Runner ───────────────────────────────────────────────────

export class BatchDistillRunner {
  private memory: MemoryService;
  private distill: DistillService;
  private chatProvider: ClaudeSdkChatProvider;
  private events: BatchDistillEvents;

  private queue: QueuedMessage[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private consolidationTimer: NodeJS.Timeout | null = null;
  private consolidation: ConsolidationService;
  private processing = false;
  private running = false;
  private batchCounter = 0;
  private consolidationIntervalMs: number;
  private consolidationEnabled: boolean;

  // Opt-out tracking
  private optedOutThreads = new Set<string>();
  private globalEnabled = true;

  // Config (from memory-config.json)
  private batchMaxMessages: number;
  private batchIntervalMs: number;
  private sessionRefreshMs: number;

  // TopicKey cache
  private topicKeysCache: Map<string, { keys: string[]; fetchedAt: number }> = new Map();
  private static TOPIC_CACHE_TTL = 5 * 60 * 1000;

  private configUnsubscribe: (() => void) | null = null;

  constructor(
    memory: MemoryService,
    events: BatchDistillEvents,
    options?: { model?: string; cwd?: string },
  ) {
    this.memory = memory;
    this.events = events;

    const config = getMemoryConfig();
    this.batchMaxMessages = config.distill.batchMaxMessages;
    this.batchIntervalMs = config.distill.batchIntervalMs;
    this.sessionRefreshMs = config.distill.sessionRefreshMs;
    this.globalEnabled = config.distill.enabled;
    this.consolidationIntervalMs = config.consolidation.intervalMs;
    this.consolidationEnabled = config.consolidation.enabled;
    this.consolidation = new ConsolidationService(memory);

    // Create SDK chat provider
    this.chatProvider = new ClaudeSdkChatProvider({
      model: options?.model ?? config.distill.model,
      cwd: options?.cwd,
    });

    const chatService = new ChatService(this.chatProvider);
    this.distill = new DistillService(chatService);
  }

  /** Start the batch processing loop */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Listen for config changes
    this.configUnsubscribe = onConfigChange((config) => {
      this.applyConfig(config);
    });

    if (!this.globalEnabled) {
      log.info('Batch distill runner started (globally disabled — waiting for opt-in)');
      return;
    }

    await this.startTimers();
    log.info(
      { batchMax: this.batchMaxMessages, intervalMs: this.batchIntervalMs, refreshMs: this.sessionRefreshMs },
      'Batch distill runner started',
    );
  }

  /** Stop the batch processing loop */
  async stop(): Promise<void> {
    this.running = false;
    this.stopTimers();
    this.configUnsubscribe?.();
    this.configUnsubscribe = null;

    // Process remaining queue
    if (this.queue.length > 0) {
      log.info({ remaining: this.queue.length }, 'Processing remaining queue before shutdown');
      await this.processBatch();
    }

    await this.chatProvider.closeSession();
    log.info('Batch distill runner stopped');
  }

  /** Enqueue a message for batch distill */
  enqueue(msg: QueuedMessage): void {
    if (!this.running || !this.globalEnabled) return;

    // Check opt-out
    const threadKey = msg.threadId ?? msg.channelId;
    if (this.optedOutThreads.has(threadKey)) return;

    // Check project exclusion
    const config = getMemoryConfig();
    if (msg.project && config.distill.excludeProjects.includes(msg.project)) return;
    if (config.distill.excludeChannels.includes(msg.channelId)) return;

    this.queue.push(msg);
    log.debug({ queueLen: this.queue.length, speaker: msg.speaker }, 'Message enqueued');

    // Check if batch threshold reached
    if (this.queue.length >= this.batchMaxMessages) {
      this.triggerBatch();
    }
  }

  /** Opt out a thread from distill */
  optOutThread(threadId: string): void {
    this.optedOutThreads.add(threadId);
    // Remove any queued messages for this thread
    this.queue = this.queue.filter((m) => (m.threadId ?? m.channelId) !== threadId);
    log.info({ threadId }, 'Thread opted out of memory collection');
  }

  /** Opt in a thread */
  optInThread(threadId: string): void {
    this.optedOutThreads.delete(threadId);
    log.info({ threadId }, 'Thread opted in to memory collection');
  }

  /** Check if a thread is opted out */
  isOptedOut(threadId: string): boolean {
    return this.optedOutThreads.has(threadId);
  }

  /** Set global enabled/disabled */
  async setGlobalEnabled(enabled: boolean): Promise<void> {
    this.globalEnabled = enabled;
    if (enabled && this.running) {
      await this.startTimers();
      log.info('Batch distill globally enabled');
    } else if (!enabled) {
      this.stopTimers();
      log.info('Batch distill globally disabled');
    }
  }

  get isGlobalEnabled(): boolean {
    return this.globalEnabled;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Internal ────────────────────────────────────────────────

  private async startTimers(): Promise<void> {
    this.stopTimers();

    // Batch interval timer
    this.batchTimer = setInterval(() => {
      if (this.queue.length > 0) {
        this.triggerBatch();
      }
    }, this.batchIntervalMs);

    // Session refresh timer
    this.refreshTimer = setInterval(async () => {
      try {
        await this.chatProvider.refreshSession();
        await this.events.onSessionRefresh?.();
        log.info('SDK session refreshed');
      } catch (err) {
        log.error({ err }, 'Failed to refresh SDK session');
      }
    }, this.sessionRefreshMs);

    // Consolidation timer
    if (this.consolidationEnabled) {
      this.consolidationTimer = setInterval(() => {
        this.runConsolidation().catch((err) => {
          log.error({ err }, 'Consolidation failed');
        });
      }, this.consolidationIntervalMs);
      log.info({ intervalMs: this.consolidationIntervalMs }, 'Consolidation scheduler started');
    }
  }

  private stopTimers(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      this.consolidationTimer = null;
    }
  }

  /** Run consolidation manually or from timer */
  async runConsolidation(): Promise<ConsolidationReport | null> {
    try {
      log.info('Running scheduled consolidation');
      const report = await this.consolidation.consolidate({ dryRun: false });
      log.info(
        { merged: report.totalMerged, cleaned: report.totalCleaned, remaining: report.totalRemaining },
        'Consolidation complete',
      );
      await this.events.onConsolidationComplete?.(report);
      return report;
    } catch (err) {
      log.error({ err }, 'Consolidation failed');
      await this.events.onError?.(err as Error);
      return null;
    }
  }

  private triggerBatch(): void {
    if (this.processing) return;
    // Fire and forget — errors are caught inside processBatch
    this.processBatch().catch((err) => {
      log.error({ err }, 'Unexpected error in batch processing');
    });
  }

  private async processBatch(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const batch = this.queue.splice(0, this.batchMaxMessages);
    this.batchCounter++;
    const batchNum = this.batchCounter;

    log.info({ batchNum, count: batch.length }, 'Processing batch');

    try {
      // Group messages by project
      const byProject = new Map<string, { msgs: QueuedMessage[]; indices: number[] }>();
      for (let i = 0; i < batch.length; i++) {
        const project = batch[i].project ?? 'default';
        if (!byProject.has(project)) byProject.set(project, { msgs: [], indices: [] });
        const group = byProject.get(project)!;
        group.msgs.push(batch[i]);
        group.indices.push(i);
      }

      log.info({ batchNum, projects: Array.from(byProject.keys()), total: batch.length }, 'Split batch by project');

      const batchItems: BatchResultItem[] = new Array(batch.length);
      let stored = 0;
      let superseded = 0;
      let resolved = 0;
      let skipped = 0;
      let errors = 0;

      // Process each project independently
      for (const [project, { msgs, indices }] of byProject) {
        try {
          // Fetch project context once
          const CONTEXT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
          const MEMORY_CAP_PER_PROJECT = 50;
          const cutoff = new Date(Date.now() - CONTEXT_WINDOW_MS).toISOString();

          const openItems = await this.memory.getByProject(project, { statuses: ['open'], limit: 100 });
          const taskRefs: OpenTaskRef[] = openItems
            .filter((t) => t.kind === 'task')
            .map((t) => ({ id: t.id, text: t.text, topicKey: t.topicKey ?? '', priority: t.priority }));

          const allItems = await this.memory.getByProject(project, { limit: 500 });
          const memRefs: ExistingMemoryRef[] = allItems
            .filter((m) => m.kind !== 'task' && m.status !== 'superseded' && m.createdAt >= cutoff)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, MEMORY_CAP_PER_PROJECT)
            .map((m) => ({
              id: m.id, text: m.text, kind: m.kind,
              topicKey: m.topicKey ?? '', priority: m.priority, createdAt: m.createdAt,
            }));

          const topicKeys = await this.getTopicKeys(project);

          // Build distill items for this project only
          const distillItems: BatchDistillItem[] = msgs.map((msg, i) => ({
            id: i,
            project,
            message: {
              speaker: `${msg.displayName} (${msg.speaker})`,
              content: msg.content,
              timestamp: msg.timestamp,
            },
            context: msg.context,
            existingTopicKeys: topicKeys,
            openTasks: taskRefs,
            existingMemories: memRefs,
          }));

          // Run distill for this project
          const distillResults = await this.distill.distillBatch(distillItems);

          // Process results
          for (const dr of distillResults) {
            const originalIdx = indices[dr.id];
            const msg = batch[originalIdx];
            try {
              const item = await this.processDistillResult(dr, msg, project);
              batchItems[originalIdx] = item;
              switch (item.action) {
                case 'stored': stored++; break;
                case 'superseded': superseded++; break;
                case 'resolved_task': resolved++; break;
                case 'skipped': skipped++; break;
                case 'error': errors++; break;
              }
            } catch (err) {
              errors++;
              batchItems[originalIdx] = { action: 'error', error: (err as Error).message };
            }
          }
        } catch (err) {
          log.error({ err, project, batchNum }, 'Project sub-batch failed');
          for (const idx of indices) {
            errors++;
            batchItems[idx] = { action: 'error', error: (err as Error).message };
          }
        }
      }

      const result: BatchResult = {
        batchNumber: batchNum,
        timestamp: new Date().toISOString(),
        items: batchItems.filter(Boolean),
        totalProcessed: batch.length,
        stored,
        superseded,
        resolved,
        skipped,
        errors,
      };

      log.info(
        { batchNum, total: batch.length, projects: byProject.size, stored, superseded, resolved, skipped, errors },
        'Batch complete',
      );

      await this.events.onBatchComplete(result);
    } catch (err) {
      log.error({ err, batchNum }, 'Batch processing failed');
      await this.events.onError?.(err as Error);
    } finally {
      this.processing = false;
    }
  }

  private async processDistillResult(
    dr: BatchDistillResult,
    msg: QueuedMessage,
    project: string,
  ): Promise<BatchResultItem> {
    const { result } = dr;

    if (!result.shouldStore) {
      return { action: 'skipped' };
    }

    // Agent observations are noise
    if ((msg.speaker === 'claude' || msg.speaker === 'codex') && result.kind === 'observation') {
      return { action: 'skipped' };
    }

    const speakerResolved = (result.speaker as MemorySpeaker) ?? msg.speaker;

    // Resolve task path: mark open tasks as resolved + store the fact
    if (result.memoryAction === 'resolve_task' && result.resolveTaskIds?.length) {
      let resolvedCount = 0;
      // Get task project ownership for validation
      const openTasks = await this.memory.getByProject(project, { statuses: ['open'], limit: 200 });
      const projectTaskIds = new Set(openTasks.filter(t => t.kind === 'task').map(t => t.id));
      for (const taskId of result.resolveTaskIds) {
        if (!projectTaskIds.has(taskId)) {
          log.warn({ taskId, project }, 'Skipping task resolution: task does not belong to this project');
          continue;
        }
        try {
          await this.memory.updateStatus(taskId, 'resolved');
          resolvedCount++;
          log.info({ taskId, project, evidence: result.distilled.slice(0, 60) }, 'Task resolved via distill');
        } catch (err) {
          log.warn({ taskId, err }, 'Failed to resolve task');
        }
      }

      // Also store the completion as a fact
      if (result.shouldStore && result.distilled) {
        await this.memory.storeIfNew(result.distilled, {
          project,
          kind: 'fact',
          source: 'session',
          speaker: speakerResolved,
          priority: result.priority,
          topicKey: result.topicKey,
          channelId: msg.channelId,
          threadId: msg.threadId,
        });
      }

      return {
        action: 'resolved_task',
        distilled: result.distilled,
        kind: 'fact',
        priority: result.priority,
        topicKey: result.topicKey,
        resolvedTaskIds: result.resolveTaskIds,
      };
    }

    // Supersede path
    if (result.memoryAction === 'update' && result.anchorTerms && result.anchorTerms.length > 0) {
      const vector = await this.memory.embedForSearch(result.distilled);
      const candidate = await this.memory.findSupersedeCandidate(vector, {
        project,
        topicKey: result.topicKey,
        anchorTerms: result.anchorTerms,
        kind: result.kind as MemoryKind,
      });

      if (candidate) {
        const newId = await this.memory.store(result.distilled, {
          project,
          kind: result.kind as MemoryKind,
          source: 'session',
          speaker: speakerResolved,
          priority: result.priority,
          topicKey: result.topicKey,
          channelId: msg.channelId,
          threadId: msg.threadId,
          vector,
          supersedesId: candidate.id,
        });
        await this.memory.markSuperseded(candidate.id, newId);

        return {
          action: 'superseded',
          distilled: result.distilled,
          kind: result.kind,
          priority: result.priority,
          topicKey: result.topicKey,
          oldMemoryId: candidate.id,
          newMemoryId: newId,
        };
      }
    }

    // Normal store
    const id = await this.memory.storeIfNew(result.distilled, {
      project,
      kind: result.kind as MemoryKind,
      source: 'session',
      speaker: speakerResolved,
      priority: result.priority,
      topicKey: result.topicKey,
      channelId: msg.channelId,
      threadId: msg.threadId,
    });

    if (id) {
      return {
        action: 'stored',
        distilled: result.distilled,
        kind: result.kind,
        priority: result.priority,
        topicKey: result.topicKey,
        newMemoryId: id,
      };
    }

    // Duplicate
    return { action: 'skipped' };
  }

  private async getTopicKeys(project: string): Promise<string[]> {
    const cached = this.topicKeysCache.get(project);
    if (cached && Date.now() - cached.fetchedAt < BatchDistillRunner.TOPIC_CACHE_TTL) {
      return cached.keys;
    }
    try {
      const keys = await this.memory.getTopicKeys(project);
      this.topicKeysCache.set(project, { keys, fetchedAt: Date.now() });
      return keys;
    } catch {
      return cached?.keys ?? [];
    }
  }

  private applyConfig(config: MemoryConfig): void {
    const d = config.distill;
    const changes: string[] = [];

    if (this.batchMaxMessages !== d.batchMaxMessages) {
      changes.push(`batch: ${this.batchMaxMessages}→${d.batchMaxMessages}`);
    }
    if (this.batchIntervalMs !== d.batchIntervalMs) {
      changes.push(`interval: ${Math.round(this.batchIntervalMs / 1000)}s→${Math.round(d.batchIntervalMs / 1000)}s`);
    }
    if (this.sessionRefreshMs !== d.sessionRefreshMs) {
      changes.push(`refresh: ${Math.round(this.sessionRefreshMs / 60000)}m→${Math.round(d.sessionRefreshMs / 60000)}m`);
    }
    if (d.enabled !== this.globalEnabled) {
      changes.push(d.enabled ? 'enabled' : 'disabled');
    }

    this.batchMaxMessages = d.batchMaxMessages;
    this.batchIntervalMs = d.batchIntervalMs;
    this.sessionRefreshMs = d.sessionRefreshMs;
    this.consolidationIntervalMs = config.consolidation.intervalMs;
    this.consolidationEnabled = config.consolidation.enabled;

    if (d.enabled !== this.globalEnabled) {
      this.setGlobalEnabled(d.enabled).catch((err) => {
        log.error({ err }, 'Failed to apply global enabled change');
      });
    }

    if (changes.length > 0) {
      const summary = `⚙️ **Memory config updated** — ${changes.join(', ')}`;
      log.info({ changes }, 'Config changed');
      this.events.onConfigChange?.(summary)?.catch?.((err: any) => {
        log.error({ err }, 'Failed to notify config change');
      });

      if (this.running && this.globalEnabled) {
        this.startTimers().catch((err) => {
          log.error({ err }, 'Failed to restart timers after config change');
        });
      }
    }
  }
}
