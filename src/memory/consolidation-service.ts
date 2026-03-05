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

    // ── Phase 1: Merge near-duplicates ──────────────────

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
