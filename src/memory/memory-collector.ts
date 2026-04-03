import { logger } from '../utils/logger.js';
import { type MemoryKind, type MemorySpeaker } from './memory-service.js';
import type { IMemoryStore } from './batch-distill-runner.js';
import { DistillService, type SlidingMessage } from './distill-service.js';
import type { BatchDistillRunner, QueuedMessage } from './batch-distill-runner.js';

const log = logger.child({ component: 'memory-collector' });

// ── Types ────────────────────────────────────────────────────

export interface CollectorMessage {
  speaker: MemorySpeaker;
  displayName: string;
  content: string;
  channelId: string;
  threadId?: string;
  project?: string;
  timestamp?: string;
}

export interface MemoryCollectorOptions {
  windowSize?: number;    // Sliding window size (default: 15)
  project?: string;       // Default project name
  /** If set, delegates distill to the batch runner instead of processing immediately */
  batchRunner?: BatchDistillRunner;
}

// ── Collector ────────────────────────────────────────────────

export class MemoryCollector {
  private memory: IMemoryStore;
  private distill: DistillService;
  private defaultProject: string;
  private windowSize: number;
  private processing = false;
  private batchRunner: BatchDistillRunner | null;

  // Sliding window per channel (channelId → recent messages)
  private windows: Map<string, SlidingMessage[]> = new Map();

  // Queue for messages that arrive while processing (legacy immediate mode)
  private queue: CollectorMessage[] = [];

  // Cached topicKeys per project (refreshed periodically)
  private topicKeysCache: Map<string, { keys: string[]; fetchedAt: number }> = new Map();
  private static TOPIC_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    memory: IMemoryStore,
    distill: DistillService,
    options?: MemoryCollectorOptions,
  ) {
    this.memory = memory;
    this.distill = distill;
    this.windowSize = options?.windowSize ?? 15;
    this.defaultProject = options?.project ?? 'default';
    this.batchRunner = options?.batchRunner ?? null;
  }

  /** Attach a batch runner (can be set after construction) */
  setBatchRunner(runner: BatchDistillRunner): void {
    this.batchRunner = runner;
    log.info('Batch runner attached to collector');
  }

  /**
   * Process a message: add to sliding window, then either:
   * - Batch mode: enqueue to BatchDistillRunner with context snapshot
   * - Legacy mode: distill immediately and store
   */
  async onMessage(msg: CollectorMessage): Promise<void> {
    const ts = msg.timestamp ?? new Date().toISOString();
    const channelKey = msg.threadId ?? msg.channelId;

    // Add to sliding window
    const window = this.windows.get(channelKey) ?? [];
    window.push({
      speaker: `${msg.displayName} (${msg.speaker})`,
      content: msg.content,
    });
    // Trim window
    if (window.length > this.windowSize) {
      window.splice(0, window.length - this.windowSize);
    }
    this.windows.set(channelKey, window);

    // Batch mode: delegate to runner with context snapshot
    if (this.batchRunner) {
      const context = window.slice(0, -1); // everything except current message
      const queued: QueuedMessage = {
        speaker: msg.speaker,
        displayName: msg.displayName,
        content: msg.content,
        channelId: msg.channelId,
        threadId: msg.threadId,
        project: msg.project ?? this.defaultProject,
        timestamp: ts,
        context: [...context], // snapshot
      };
      this.batchRunner.enqueue(queued);
      return;
    }

    // Legacy immediate mode
    this.queue.push({ ...msg, timestamp: ts });
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const msg = this.queue.shift()!;
        await this.distillAndStore(msg);
      }
    } finally {
      this.processing = false;
    }
  }

  private async distillAndStore(msg: CollectorMessage): Promise<void> {
    const channelKey = msg.threadId ?? msg.channelId;
    const window = this.windows.get(channelKey) ?? [];

    // Context = all messages EXCEPT the current one (it's the last in window)
    const context = window.slice(0, -1);

    try {
      const project = msg.project ?? this.defaultProject;
      const existingTopicKeys = await this.getTopicKeys(project);

      const result = await this.distill.distill({
        message: {
          speaker: `${msg.displayName} (${msg.speaker})`,
          content: msg.content,
          timestamp: msg.timestamp ?? new Date().toISOString(),
        },
        context,
        existingTopicKeys,
      });

      if (!result.shouldStore) {
        log.debug({ speaker: msg.speaker, content: msg.content.slice(0, 50) }, 'Message skipped by distill');
        return;
      }

      // Agent observations are almost always noise (status updates, not decisions)
      if ((msg.speaker === 'claude' || msg.speaker === 'codex') && result.kind === 'observation') {
        log.debug({ speaker: msg.speaker, text: result.distilled.slice(0, 50) }, 'Skipped agent observation');
        return;
      }

      const speakerResolved = (result.speaker as MemorySpeaker) ?? msg.speaker;

      // Supersede path: if distill detected an update with anchor terms
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
          log.info(
            { newId, oldId: candidate.id, score: candidate.score, topic: result.topicKey },
            'Memory superseded',
          );
          return;
        }
        // No candidate found — fall through to normal create
      }

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
        log.info(
          { kind: result.kind, priority: result.priority, topic: result.topicKey },
          'Memory stored',
        );
      } else {
        log.debug({ topic: result.topicKey }, 'Duplicate memory skipped');
      }
    } catch (err) {
      log.error({ err, speaker: msg.speaker }, 'Distill failed for message');
    }
  }

  private async getTopicKeys(project: string): Promise<string[]> {
    const cached = this.topicKeysCache.get(project);
    if (cached && Date.now() - cached.fetchedAt < MemoryCollector.TOPIC_CACHE_TTL) {
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

  get windowCount(): number {
    return this.windows.size;
  }

  get queueLength(): number {
    return this.batchRunner ? this.batchRunner.queueLength : this.queue.length;
  }
}
