import { logger } from '../utils/logger.js';
import type { MemoryService } from './memory-service.js';

const log = logger.child({ component: 'consolidation' });

// ── Types ────────────────────────────────────────────────────

export interface ConsolidationOptions {
  project?: string;
  dryRun: boolean;
  similarityThreshold?: number;   // default 0.93
  lowValueMaxPriority?: number;   // default 2
}

export interface MergeDetail {
  keptId: string;
  keptText: string;
  deletedId: string;
  deletedText: string;
  similarity: number;
}

export interface CleanDetail {
  id: string;
  text: string;
  kind: string;
  speaker: string;
  priority: number;
  ageDays: number;
  reason: string;
}

export interface ProjectReport {
  project: string;
  beforeCount: number;
  merged: number;
  cleaned: number;
  afterCount: number;
  mergeDetails: MergeDetail[];
  cleanDetails: CleanDetail[];
}

export interface ConsolidationReport {
  projectReports: ProjectReport[];
  totalMerged: number;
  totalCleaned: number;
  totalRemaining: number;
}

// ── Helpers ──────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ── Service ──────────────────────────────────────────────────

export class ConsolidationService {
  private memory: MemoryService;

  constructor(memory: MemoryService) {
    this.memory = memory;
  }

  async consolidate(options: ConsolidationOptions): Promise<ConsolidationReport> {
    const projects = options.project
      ? [options.project]
      : await this.memory.listProjects();

    const projectReports: ProjectReport[] = [];

    for (const project of projects) {
      const report = await this.consolidateProject(project, options);
      projectReports.push(report);
    }

    return {
      projectReports,
      totalMerged: projectReports.reduce((s, r) => s + r.merged, 0),
      totalCleaned: projectReports.reduce((s, r) => s + r.cleaned, 0),
      totalRemaining: projectReports.reduce((s, r) => s + r.afterCount, 0),
    };
  }

  private async consolidateProject(
    project: string,
    options: ConsolidationOptions,
  ): Promise<ProjectReport> {
    const threshold = options.similarityThreshold ?? 0.93;
    const maxPriority = options.lowValueMaxPriority ?? 2;
    const dryRun = options.dryRun;

    const allRecords = await this.memory.getAllWithVectors(project);
    const beforeCount = allRecords.length;
    const deletedIds = new Set<string>();
    const mergeDetails: MergeDetail[] = [];
    const cleanDetails: CleanDetail[] = [];

    // ── Phase 0: TopicKey-based near-duplicate merge ────
    // Same topicKey+kind within 7 days + cosine >= 0.85 → merge
    // This catches near-duplicates that the stricter Phase 1 (0.93) misses

    const byTopicKind = new Map<string, typeof allRecords>();
    for (const record of allRecords) {
      if (!record.topicKey || deletedIds.has(record.id)) continue;
      const key = `${record.topicKey}::${record.kind}`;
      const group = byTopicKind.get(key) ?? [];
      group.push(record);
      byTopicKind.set(key, group);
    }

    for (const [groupKey, group] of byTopicKind) {
      if (group.length <= 1) continue;

      // Sort: highest priority first, then newest
      group.sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt));
      const keep = group[0];

      for (let i = 1; i < group.length; i++) {
        const del = group[i];
        if (deletedIds.has(del.id)) continue;

        // Time guard: only merge within 7-day window
        const timeDiff = Math.abs(
          new Date(keep.createdAt).getTime() - new Date(del.createdAt).getTime()
        );
        if (timeDiff > SEVEN_DAYS_MS) continue;

        // Cosine similarity guard
        const sim = cosineSimilarity(keep.vector, del.vector);
        if (sim < 0.85) continue;

        mergeDetails.push({
          keptId: keep.id,
          keptText: keep.text,
          deletedId: del.id,
          deletedText: del.text,
          similarity: sim,
        });

        if (!dryRun) {
          await this.memory.remove(del.id);
        }
        deletedIds.add(del.id);
        log.info({ groupKey, keptId: keep.id, deletedId: del.id, sim: sim.toFixed(3) }, 'TopicKey merge');
      }
    }

    // ── Phase 1: Merge near-duplicates (vector-only, 0.93) ──

    for (const record of allRecords) {
      if (deletedIds.has(record.id)) continue;

      const similar = await this.memory.searchByVector(record.vector, {
        project,
        limit: 10,
        minScore: threshold,
      });

      const duplicates = similar.filter(
        (s) => s.id !== record.id && !deletedIds.has(s.id),
      );

      if (duplicates.length === 0) continue;

      // Keep highest priority, tiebreak by newest
      const candidates = [
        { id: record.id, priority: record.priority, createdAt: record.createdAt, text: record.text },
        ...duplicates.map((d) => ({
          id: d.id, priority: d.priority, createdAt: d.createdAt, text: d.text,
        })),
      ];
      candidates.sort(
        (a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt),
      );

      const keep = candidates[0];
      const toDelete = candidates.slice(1);

      for (const del of toDelete) {
        if (deletedIds.has(del.id)) continue;

        const sim = similar.find((s) => s.id === del.id)?.score ?? threshold;

        mergeDetails.push({
          keptId: keep.id,
          keptText: keep.text,
          deletedId: del.id,
          deletedText: del.text,
          similarity: sim,
        });

        if (!dryRun) {
          await this.memory.remove(del.id);
        }
        deletedIds.add(del.id);
        log.info({ keptId: keep.id, deletedId: del.id, sim }, 'Merged duplicate');
      }
    }

    // ── Phase 2: Clean junk & low-value memories ─────────

    const now = Date.now();

    for (const record of allRecords) {
      if (deletedIds.has(record.id)) continue;

      const age = now - new Date(record.createdAt).getTime();
      const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));

      // Detect distill language errors (Chinese/Japanese in Korean project)
      const hasCJKJunk = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(record.text)
        && !/[\uac00-\ud7af]/.test(record.text);  // Chinese/Japanese chars without any Korean

      // Agent progress reports (Claude/Codex observations are status updates, not decisions)
      const isAgentNoise =
        (record.speaker === 'claude' || record.speaker === 'codex') &&
        record.kind === 'observation';

      // Original low-value filter (priority-based)
      const isLowPriority =
        (record.kind === 'observation' || record.kind === 'dialog_summary') &&
        record.priority <= maxPriority;

      const reason = hasCJKJunk ? 'lang-error'
        : isAgentNoise ? 'agent-noise'
        : isLowPriority ? 'low-priority'
        : null;

      if (!reason) continue;

      cleanDetails.push({
        id: record.id,
        text: record.text,
        kind: record.kind,
        speaker: record.speaker,
        priority: record.priority,
        ageDays,
        reason,
      });

      if (!dryRun) {
        await this.memory.remove(record.id);
      }
      deletedIds.add(record.id);
      log.info({ id: record.id, kind: record.kind, ageDays }, 'Cleaned low-value memory');
    }

    // ── Phase 3: Task lifecycle management ──────────────
    // Close stale/ephemeral tasks, decay old observations & dialog_summaries

    for (const record of allRecords) {
      if (deletedIds.has(record.id)) continue;
      if (record.status !== 'open') continue;

      const age = now - new Date(record.createdAt).getTime();
      const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));

      let reason: string | null = null;

      if (record.kind === 'task') {
        // Stale tasks: open for 30+ days → expire
        if (ageDays >= 30) {
          reason = 'stale-task-30d';
        }
        // Low-priority ephemeral tasks: priority ≤ 4 and 7+ days old → expire
        else if (record.priority <= 4 && ageDays >= 7) {
          reason = 'ephemeral-task-7d';
        }
      } else if (record.kind === 'observation' && ageDays >= 30) {
        // Old observations: decay after 30 days
        reason = 'observation-decay-30d';
      } else if (record.kind === 'dialog_summary' && ageDays >= 14) {
        // Old dialog summaries: decay after 14 days
        reason = 'dialog-summary-decay-14d';
      }

      if (!reason) continue;

      cleanDetails.push({
        id: record.id,
        text: record.text,
        kind: record.kind,
        speaker: record.speaker,
        priority: record.priority,
        ageDays,
        reason,
      });

      if (!dryRun) {
        if (reason.startsWith('stale-task') || reason.startsWith('ephemeral-task')) {
          // Tasks: mark as expired (soft transition, not delete)
          await this.memory.updateStatus(record.id, 'expired');
        } else {
          // Observations/summaries: delete
          await this.memory.remove(record.id);
        }
      }
      deletedIds.add(record.id);
      log.info({ id: record.id, kind: record.kind, ageDays, reason }, 'Lifecycle cleanup');
    }

    return {
      project,
      beforeCount,
      merged: mergeDetails.length,
      cleaned: cleanDetails.length,
      afterCount: beforeCount - deletedIds.size,
      mergeDetails,
      cleanDetails,
    };
  }
}
