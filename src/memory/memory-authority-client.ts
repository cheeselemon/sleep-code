/**
 * Memory Authority Client
 *
 * HTTP client for the Memory Authority server (MCP server with internal API).
 * Replaces direct MemoryService usage in Discord bot and CLI.
 * All LanceDB writes go through the Authority to prevent version conflicts.
 */

import { logger } from '../utils/logger.js';
import type {
  MemoryRecord,
  MemoryUnit,
  MemorySearchResult,
  MemoryStatus,
  MemoryKind,
  MemorySource,
  MemorySpeaker,
} from './memory-service.js';

const log = logger.child({ component: 'memory-authority-client' });

// ── Types ────────────────────────────────────────────────────

/** Matches MemoryService.store() options parameter */
export interface StoreOptions {
  project: string;
  kind: MemoryKind;
  source: MemorySource;
  speaker?: MemorySpeaker;
  priority?: number;
  topicKey?: string;
  channelId?: string;
  threadId?: string;
  expiresAt?: string;
  vector?: number[];
  supersedesId?: string;
}

/** Matches MemoryService.updateFields() fields parameter */
export type UpdateFieldsInput = Partial<Pick<MemoryUnit, 'topicKey' | 'speaker' | 'priority' | 'text' | 'kind'>>;

export interface DistillBatchPayload {
  items: Array<{
    action: 'store' | 'update' | 'resolve_task' | 'skip';
    record?: { text: string; options: StoreOptions };
    targetId?: string;
    reason?: string;
  }>;
  project: string;
}

export interface ConsolidateOptions {
  project?: string;
  dryRun?: boolean;
}

export interface DigestOptions {
  timezone?: string;
  customPrompt?: string;
}

// ── Client ───────────────────────────────────────────────────

const READ_RETRIES = 3;
const WRITE_RETRIES = 0; // writes are NOT retried (not idempotent)
const BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_ERRORS = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'UND_ERR_SOCKET'];

export class MemoryAuthorityClient {
  private baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:24242') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  // ── Lifecycle ───────────────────────────────────────────

  /** No-op for API compatibility with MemoryService */
  async initialize(): Promise<void> {
    // Authority manages its own LanceDB lifecycle
  }

  /** No-op for API compatibility with MemoryService */
  shutdown(): void {
    // Nothing to clean up — HTTP client is stateless
  }

  // ── Health ──────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.baseUrl}/internal/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Write methods (no retry — not idempotent) ───────────

  /** Store a new memory. Returns the generated ID. */
  async store(
    text: string,
    options: StoreOptions,
  ): Promise<string> {
    const result = await this.postWrite<{ id: string }>('/internal/store', { text, options });
    return result.id;
  }

  /** Store if not a duplicate. Returns ID or null if duplicate. */
  async storeIfNew(
    text: string,
    options: Omit<StoreOptions, 'vector' | 'supersedesId'>,
  ): Promise<string | null> {
    const result = await this.postWrite<{ id: string | null }>('/internal/storeIfNew', { text, options });
    return result.id;
  }

  async markSuperseded(oldId: string, newId: string): Promise<void> {
    await this.postWrite('/internal/markSuperseded', { oldId, newId });
  }

  async updateStatus(id: string, status: MemoryStatus): Promise<void> {
    await this.postWrite('/internal/updateStatus', { id, status });
  }

  async remove(id: string): Promise<void> {
    await this.postWrite('/internal/remove', { id });
  }

  async updateFields(id: string, fields: UpdateFieldsInput): Promise<void> {
    await this.postWrite('/internal/updateFields', { id, fields });
  }

  async undoSupersede(id: string): Promise<void> {
    await this.postWrite('/internal/undoSupersede', { id });
  }

  async snooze(id: string, until: string): Promise<void> {
    await this.postWrite('/internal/snooze', { id, until });
  }

  async reinforcePriority(id: string, currentPriority: number): Promise<void> {
    await this.postWrite('/internal/reinforcePriority', { id, currentPriority });
  }

  // ── Read methods (via /internal/query, with retry) ──────

  async search(query: string, options?: {
    project?: string;
    kinds?: MemoryKind[];
    statuses?: MemoryStatus[];
    limit?: number;
    includeSuperseded?: boolean;
  }): Promise<MemorySearchResult[]> {
    return this.postRead<MemorySearchResult[]>('/internal/query', { op: 'search', query, ...options });
  }

  async getByProject(project: string, options?: {
    statuses?: MemoryStatus[];
    limit?: number;
    includeSuperseded?: boolean;
  }): Promise<MemoryUnit[]> {
    return this.postRead<MemoryUnit[]>('/internal/query', { op: 'getByProject', project, ...options });
  }

  async getAllWithVectors(project: string): Promise<MemoryRecord[]> {
    return this.postRead<MemoryRecord[]>('/internal/query', { op: 'getAllWithVectors', project });
  }

  async listProjects(): Promise<string[]> {
    return this.postRead<string[]>('/internal/query', { op: 'listProjects' });
  }

  async getTopicKeys(project: string): Promise<string[]> {
    return this.postRead<string[]>('/internal/query', { op: 'getTopicKeys', project });
  }

  async searchByVector(vector: number[], options?: {
    project?: string;
    limit?: number;
    minScore?: number;
  }): Promise<MemorySearchResult[]> {
    return this.postRead<MemorySearchResult[]>('/internal/query', { op: 'searchByVector', vector, ...options });
  }

  async findSupersedeCandidate(
    vector: number[],
    options: {
      project: string;
      topicKey?: string;
      anchorTerms?: string[];
      kind?: MemoryKind;
    },
  ): Promise<{ id: string; score: number } | null> {
    return this.postRead<{ id: string; score: number } | null>('/internal/query', {
      op: 'findSupersedeCandidate',
      vector,
      ...options,
    });
  }

  async embedForSearch(text: string): Promise<number[]> {
    return this.postRead<number[]>('/internal/query', { op: 'embedForSearch', text });
  }

  async countByProject(project: string): Promise<number> {
    return this.postRead<number>('/internal/query', { op: 'countByProject', project });
  }

  // ── Composite methods (for later steps) ─────────────────

  async distillBatch(payload: DistillBatchPayload): Promise<unknown> {
    return this.postWrite('/internal/distill-batch', payload);
  }

  async consolidate(options?: ConsolidateOptions): Promise<unknown> {
    return this.postWrite('/internal/consolidate', options ?? {});
  }

  async generateDigest(options?: DigestOptions): Promise<unknown> {
    return this.postWrite('/internal/generate-digest', options ?? {});
  }

  // ── Internal HTTP helpers ───────────────────────────────

  /** POST for write operations — no retry (not idempotent) */
  private async postWrite<T>(path: string, body: unknown): Promise<T> {
    return this.doPost<T>(path, body, WRITE_RETRIES);
  }

  /** POST for read operations — with retry */
  private async postRead<T>(path: string, body: unknown): Promise<T> {
    return this.doPost<T>(path, body, READ_RETRIES);
  }

  private async doPost<T>(path: string, body: unknown, maxRetries: number): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (res.status === 503 && attempt < maxRetries) {
          throw new Error('Authority returned 503');
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Authority ${path} failed: ${res.status} ${text}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return (await res.json()) as T;
        }

        // Non-JSON success (e.g. 204 No Content for void methods)
        return undefined as unknown as T;
      } catch (err: any) {
        clearTimeout(timeout);
        lastError = err;

        const isAbortTimeout = err.name === 'AbortError';
        const isRetryable =
          isAbortTimeout ||
          RETRYABLE_ERRORS.some((code) => err.message?.includes(code) || err.cause?.code === code) ||
          err.message?.includes('503');

        if (isRetryable && attempt < maxRetries) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          log.warn({ path, attempt: attempt + 1, delay, err: err.message }, 'Memory Authority request failed, retrying');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        break;
      }
    }

    log.error({ path, err: lastError?.message }, 'Memory Authority request failed');
    throw lastError;
  }
}
