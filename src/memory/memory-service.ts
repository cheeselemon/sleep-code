import * as lancedb from '@lancedb/lancedb';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import { EmbeddingService } from './embedding-provider.js';

const log = logger.child({ component: 'memory' });

const MEMORY_DIR = join(homedir(), '.sleep-code', 'memory');
const DB_PATH = join(MEMORY_DIR, 'lancedb');

// ── Types ────────────────────────────────────────────────────

export type MemoryKind = 'fact' | 'task' | 'observation' | 'proposal' | 'feedback' | 'dialog_summary' | 'decision';
export type MemoryStatus = 'open' | 'in_progress' | 'snoozed' | 'resolved' | 'expired';
export type MemorySource = 'user' | 'heartbeat' | 'session' | 'system';
export type MemorySpeaker = 'user' | 'claude' | 'codex' | 'system';

export interface MemoryUnit {
  id: string;
  project: string;
  text: string;
  kind: MemoryKind;
  status: MemoryStatus;
  source: MemorySource;
  speaker: MemorySpeaker;
  priority: number;          // 0-10, higher = more important
  topicKey?: string;
  channelId?: string;
  threadId?: string;
  snoozeUntil?: string;      // ISO timestamp
  expiresAt?: string;        // ISO timestamp
  createdAt: string;
  updatedAt: string;
  // Embedding metadata
  embeddingModel: string;
  embeddingProvider: string;
  embeddingDim: number;
}

export interface MemoryRecord extends MemoryUnit {
  vector: number[];
}

export interface MemorySearchResult extends MemoryUnit {
  score: number;
}

export interface SearchOptions {
  project?: string;
  kinds?: MemoryKind[];
  statuses?: MemoryStatus[];
  limit?: number;
}

// ── Service ──────────────────────────────────────────────────

const TABLE_NAME = 'memory_units';

export class MemoryService {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private embedding: EmbeddingService;

  constructor(embedding: EmbeddingService) {
    this.embedding = embedding;
  }

  async initialize(): Promise<void> {
    await mkdir(MEMORY_DIR, { recursive: true });
    this.db = await lancedb.connect(DB_PATH);

    const tables = await this.db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
      log.info('Opened existing memory table');
    } else {
      log.info('Memory table will be created on first insert');
    }
  }

  private async ensureTable(record: MemoryRecord): Promise<lancedb.Table> {
    if (this.table) return this.table;
    if (!this.db) throw new Error('MemoryService not initialized');

    this.table = await this.db.createTable(TABLE_NAME, [record]);
    log.info('Created memory table');
    return this.table;
  }

  // ── Write ────────────────────────────────────────────────

  async store(
    text: string,
    options: {
      project: string;
      kind: MemoryKind;
      source: MemorySource;
      speaker?: MemorySpeaker;
      priority?: number;
      topicKey?: string;
      channelId?: string;
      threadId?: string;
      expiresAt?: string;
      vector?: number[];       // pre-computed vector to avoid re-embedding
    }
  ): Promise<string> {
    const vector = options.vector ?? await this.embedding.embedSingle(text);
    const spec = this.embedding.getSpec();
    const now = new Date().toISOString();
    const id = randomUUID();

    const record: MemoryRecord = {
      id,
      project: options.project,
      text,
      kind: options.kind,
      status: 'open',
      source: options.source,
      speaker: options.speaker ?? 'system',
      priority: options.priority ?? 5,
      topicKey: options.topicKey ?? '',
      channelId: options.channelId ?? '',
      threadId: options.threadId ?? '',
      snoozeUntil: '',
      expiresAt: options.expiresAt ?? '',
      createdAt: now,
      updatedAt: now,
      embeddingModel: spec.modelId,
      embeddingProvider: spec.providerId,
      embeddingDim: spec.dimension,
      vector,
    };

    const table = await this.ensureTable(record);
    await table.add([record]);

    log.info({ id, project: options.project, kind: options.kind }, 'Stored memory unit');
    return id;
  }

  // ── Dedup + Reinforcement ─────────────────────────────────

  async storeIfNew(
    text: string,
    options: {
      project: string;
      kind: MemoryKind;
      source: MemorySource;
      speaker?: MemorySpeaker;
      priority?: number;
      topicKey?: string;
      channelId?: string;
      threadId?: string;
      expiresAt?: string;
    }
  ): Promise<string | null> {
    const vector = await this.embedding.embedSingle(text);

    // Check for near-duplicates
    const similar = await this.searchByVector(vector, {
      project: options.project,
      limit: 3,
      minScore: 0.85,
    });

    if (similar.length > 0) {
      // Reinforcement: bump priority of existing memory
      await this.reinforcePriority(similar[0].id, similar[0].priority);
      log.info(
        { existingId: similar[0].id, score: similar[0].score },
        'Duplicate detected, reinforced existing memory'
      );
      return null;
    }

    return this.store(text, { ...options, vector });
  }

  async searchByVector(
    vector: number[],
    options: { project?: string; limit?: number; minScore?: number }
  ): Promise<MemorySearchResult[]> {
    if (!this.table) return [];

    const limit = options.limit ?? 5;
    let queryBuilder = this.table.search(vector).distanceType('cosine').limit(limit);

    if (options.project) {
      queryBuilder = queryBuilder.where(`project = '${options.project}'`);
    }

    const results = await queryBuilder.toArray();
    const minScore = options.minScore ?? 0;

    return results
      .map((row: Record<string, unknown>) => ({
        ...this.mapRowToUnit(row),
        score: row._distance != null ? 1 - (row._distance as number) : 0,
      }))
      .filter((r: MemorySearchResult) => r.score >= minScore);
  }

  async reinforcePriority(id: string, currentPriority: number): Promise<void> {
    if (!this.table) return;
    const newPriority = Math.min(10, currentPriority + 1);
    await this.table.update({
      where: `id = '${id}'`,
      values: { priority: newPriority, updatedAt: new Date().toISOString() },
    });
    log.debug({ id, newPriority }, 'Reinforced memory priority');
  }

  // ── Read ─────────────────────────────────────────────────

  async search(
    query: string,
    options?: SearchOptions
  ): Promise<MemorySearchResult[]> {
    if (!this.table) return [];

    const vector = await this.embedding.embedSingle(query);
    const limit = options?.limit ?? 10;

    const filters: string[] = [];
    if (options?.project) {
      filters.push(`project = '${options.project}'`);
    }
    if (options?.kinds?.length) {
      const kindList = options.kinds.map((k) => `'${k}'`).join(', ');
      filters.push(`kind IN (${kindList})`);
    }
    if (options?.statuses?.length) {
      const statusList = options.statuses.map((s) => `'${s}'`).join(', ');
      filters.push(`status IN (${statusList})`);
    }

    let queryBuilder = this.table.search(vector).distanceType('cosine').limit(limit);
    if (filters.length > 0) {
      queryBuilder = queryBuilder.where(filters.join(' AND '));
    }

    const results = await queryBuilder.toArray();

    return results.map((row: Record<string, unknown>) => ({
      ...this.mapRowToUnit(row),
      score: row._distance != null ? 1 - (row._distance as number) : 0,
    }));
  }

  async getByProject(
    project: string,
    options?: { statuses?: MemoryStatus[]; limit?: number }
  ): Promise<MemoryUnit[]> {
    if (!this.table) return [];

    const filters: string[] = [`project = '${project}'`];
    if (options?.statuses?.length) {
      const statusList = options.statuses.map((s) => `'${s}'`).join(', ');
      filters.push(`status IN (${statusList})`);
    }

    const results = await this.table
      .query()
      .where(filters.join(' AND '))
      .limit(options?.limit ?? 50)
      .toArray();

    return results.map((row: Record<string, unknown>) => this.mapRowToUnit(row));
  }

  private mapRowToUnit(row: Record<string, unknown>): MemoryUnit {
    return {
      id: row.id as string,
      project: row.project as string,
      text: row.text as string,
      kind: row.kind as MemoryKind,
      status: row.status as MemoryStatus,
      source: row.source as MemorySource,
      speaker: (row.speaker as MemorySpeaker) ?? 'system',
      priority: row.priority as number,
      topicKey: row.topicKey as string,
      channelId: row.channelId as string,
      threadId: row.threadId as string,
      snoozeUntil: row.snoozeUntil as string,
      expiresAt: row.expiresAt as string,
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
      embeddingModel: row.embeddingModel as string,
      embeddingProvider: row.embeddingProvider as string,
      embeddingDim: row.embeddingDim as number,
    };
  }

  // ── Update ───────────────────────────────────────────────

  async updateStatus(id: string, status: MemoryStatus): Promise<void> {
    if (!this.table) return;
    await this.table.update({
      where: `id = '${id}'`,
      values: { status, updatedAt: new Date().toISOString() },
    });
    log.info({ id, status }, 'Updated memory status');
  }

  async snooze(id: string, until: string): Promise<void> {
    if (!this.table) return;
    await this.table.update({
      where: `id = '${id}'`,
      values: {
        status: 'snoozed' as MemoryStatus,
        snoozeUntil: until,
        updatedAt: new Date().toISOString(),
      },
    });
    log.info({ id, until }, 'Snoozed memory');
  }

  // ── Delete ───────────────────────────────────────────────

  async remove(id: string): Promise<void> {
    if (!this.table) return;
    await this.table.delete(`id = '${id}'`);
    log.info({ id }, 'Removed memory unit');
  }

  // ── Stats ────────────────────────────────────────────────

  async countByProject(project: string): Promise<number> {
    if (!this.table) return 0;
    const results = await this.table
      .query()
      .where(`project = '${project}'`)
      .toArray();
    return results.length;
  }

  // ── Lifecycle ────────────────────────────────────────────

  shutdown(): void {
    this.table = null;
    this.db = null;
    log.info('Memory service shut down');
  }
}
