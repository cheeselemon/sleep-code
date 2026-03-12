import { logger } from '../utils/logger.js';
import { MemoryService, type MemoryKind, type MemorySpeaker } from './memory-service.js';
import { DistillService, type SlidingMessage } from './distill-service.js';

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
}

// ── Collector ────────────────────────────────────────────────

export class MemoryCollector {
  private memory: MemoryService;
  private distill: DistillService;
  private defaultProject: string;
  private windowSize: number;
  private processing = false;

  // Sliding window per channel (channelId → recent messages)
  private windows: Map<string, SlidingMessage[]> = new Map();

  // Queue for messages that arrive while processing
  private queue: CollectorMessage[] = [];

  // Cached topicKeys per project (refreshed periodically)
  private topicKeysCache: Map<string, { keys: string[]; fetchedAt: number }> = new Map();
  private static TOPIC_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    memory: MemoryService,
    distill: DistillService,
    options?: MemoryCollectorOptions,
  ) {
    this.memory = memory;
    this.distill = distill;
    this.windowSize = options?.windowSize ?? 15;
    this.defaultProject = options?.project ?? 'default';
  }

  /**
   * Process a message: add to sliding window, distill, and store if worthy.
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

    // Queue for processing
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

      const id = await this.memory.storeIfNew(result.distilled, {
        project,
        kind: result.kind as MemoryKind,
        source: 'session',
        speaker: (result.speaker as MemorySpeaker) ?? msg.speaker,
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
    return this.queue.length;
  }
}
