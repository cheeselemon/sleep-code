/**
 * Generic session store for Discord thread ↔ session mapping.
 *
 * Consolidates the repeated pattern of:
 *   - Map<sessionId, ChannelMapping>       (in-memory session state)
 *   - Map<threadId, sessionId>             (thread → session lookup)
 *   - Map<sessionId, PersistedMapping>     (disk-persisted data)
 *   - save/load JSON file
 *
 * Used by ChannelManager for PTY, Codex, and SDK session types.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { discordLogger as log } from '../utils/logger.js';

export interface PersistedMapping {
  sessionId: string;
  threadId: string;
  channelId: string;
  cwd: string;
  codexThreadId?: string;   // Codex SDK thread ID for resumeThread()
  sdkSessionId?: string;    // Claude Agent SDK session ID for resume()
  sdkModel?: string;        // Claude SDK model ID (e.g., 'claude-opus-4-7[1m]') for resume
  modelAlias?: string;      // Agent session model alias (e.g., 'gemma4', 'glm5')
}

export interface ChannelMapping {
  sessionId: string;
  channelId: string;
  threadId: string;
  channelName: string;
  threadName: string;
  sessionName: string;
  cwd: string;
  status: 'running' | 'idle' | 'ended';
  createdAt: Date;
}

export class SessionStore {
  private sessions = new Map<string, ChannelMapping>();
  private threadToSession = new Map<string, string>();
  private persistedMappings = new Map<string, PersistedMapping>();

  constructor(
    private readonly filePath: string,
    private readonly label: string,
  ) {}

  // ── In-memory session CRUD ────────────────────────────

  get(sessionId: string): ChannelMapping | undefined {
    return this.sessions.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  set(sessionId: string, mapping: ChannelMapping): void {
    this.sessions.set(sessionId, mapping);
    this.threadToSession.set(mapping.threadId, sessionId);
  }

  delete(sessionId: string): void {
    const mapping = this.sessions.get(sessionId);
    if (mapping) {
      this.threadToSession.delete(mapping.threadId);
    }
    this.sessions.delete(sessionId);
  }

  getByThread(threadId: string): string | undefined {
    return this.threadToSession.get(threadId);
  }

  setThread(threadId: string, sessionId: string): void {
    this.threadToSession.set(threadId, sessionId);
  }

  deleteThread(threadId: string): void {
    this.threadToSession.delete(threadId);
  }

  updateStatus(sessionId: string, status: 'running' | 'idle' | 'ended'): void {
    const mapping = this.sessions.get(sessionId);
    if (mapping) {
      mapping.status = status;
    }
  }

  getAllActive(): ChannelMapping[] {
    return Array.from(this.sessions.values()).filter(s => s.status !== 'ended');
  }

  values(): ChannelMapping[] {
    return Array.from(this.sessions.values());
  }

  entries(): [string, ChannelMapping][] {
    return Array.from(this.sessions.entries());
  }

  // ── Persisted mapping CRUD ────────────────────────────

  getPersisted(sessionId: string): PersistedMapping | undefined {
    return this.persistedMappings.get(sessionId);
  }

  setPersisted(sessionId: string, mapping: PersistedMapping): void {
    this.persistedMappings.set(sessionId, mapping);
  }

  deletePersisted(sessionId: string): void {
    this.persistedMappings.delete(sessionId);
  }

  getAllPersisted(): PersistedMapping[] {
    return Array.from(this.persistedMappings.values());
  }

  persistedSize(): number {
    return this.persistedMappings.size;
  }

  persistedEntries(): [string, PersistedMapping][] {
    return Array.from(this.persistedMappings.entries());
  }

  // ── File I/O ──────────────────────────────────────────

  /**
   * Load persisted mappings from disk.
   * Only populates the persisted map — caller handles thread/session restoration.
   * Returns raw array for custom processing (e.g. SDK dedup/cleanup).
   */
  async load(): Promise<PersistedMapping[]> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const mappings: PersistedMapping[] = JSON.parse(data);
      for (const m of mappings) {
        this.persistedMappings.set(m.sessionId, m);
      }
      log.info(`Loaded ${mappings.length} persisted ${this.label} mappings`);
      return mappings;
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        log.error({ err: err.message }, `Error loading ${this.label} mappings`);
      }
      return [];
    }
  }

  /**
   * Save all persisted mappings to disk.
   */
  async save(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const mappings = Array.from(this.persistedMappings.values());
      await writeFile(this.filePath, JSON.stringify(mappings, null, 2));
    } catch (err: any) {
      log.error({ err: err.message }, `Error saving ${this.label} mappings`);
    }
  }

  /**
   * Set persisted mapping and immediately save to disk.
   */
  async persistAndSave(sessionId: string, mapping: PersistedMapping): Promise<void> {
    this.setPersisted(sessionId, mapping);
    await this.save();
  }

  /**
   * Delete persisted mapping and immediately save to disk.
   */
  async deletePersistedAndSave(sessionId: string): Promise<void> {
    this.deletePersisted(sessionId);
    await this.save();
  }
}
