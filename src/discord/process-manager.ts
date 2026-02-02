import { spawn, execSync } from 'child_process';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { discordLogger as log } from '../utils/logger.js';
import type { TerminalApp } from './settings-manager.js';

const CONFIG_DIR = join(homedir(), '.sleep-code');
const REGISTRY_FILE = join(CONFIG_DIR, 'process-registry.json');

export interface ProcessEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'orphaned';
  threadId?: string;
  command: string[];
  lastVerified?: string;
}

interface ProcessRegistry {
  version: 1;
  entries: ProcessEntry[];
}

export interface ProcessManagerOptions {
  onStatusChange?: (entry: ProcessEntry, oldStatus: string) => void;
  getAutoCleanupOrphans?: () => boolean;
}

export class ProcessManager {
  private registry: ProcessRegistry = { version: 1, entries: [] };
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private onStatusChange?: (entry: ProcessEntry, oldStatus: string) => void;
  private getAutoCleanupOrphans?: () => boolean;
  private reconcilingSessionIds = new Set<string>(); // Sessions being cleaned up during reconciliation

  constructor(options?: ProcessManagerOptions) {
    this.onStatusChange = options?.onStatusChange;
    this.getAutoCleanupOrphans = options?.getAutoCleanupOrphans;
  }

  async initialize(): Promise<void> {
    await this.loadRegistry();
    await this.runHealthCheck();

    // Start periodic health check (every 60 seconds)
    this.healthCheckInterval = setInterval(() => {
      this.runHealthCheck().catch(err => {
        log.error({ err }, 'Health check failed');
      });
    }, 60000);
  }

  shutdown(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Generate a new session ID
   */
  generateSessionId(): string {
    return randomUUID();
  }

  /**
   * Spawn a new Claude Code session
   * @param cwd Working directory
   * @param sessionId Session ID
   * @param terminalApp Terminal app to use (default: background)
   */
  async spawn(cwd: string, sessionId: string, terminalApp: TerminalApp = 'background'): Promise<ProcessEntry> {
    // Get the path to the sleep-code script
    const sleepCodePath = process.argv[1];
    const command = ['node', sleepCodePath, 'run', '--session-id', sessionId, '--', 'claude'];

    log.info({ cwd, sessionId, terminalApp, command: command.join(' ') }, 'Spawning process');

    let pid: number;

    if (terminalApp === 'background') {
      // Original detached background mode
      const child = spawn(command[0], command.slice(1), {
        cwd,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, FORCE_COLOR: '1' },
      });

      if (!child.pid) {
        throw new Error('Failed to spawn process - no PID');
      }

      child.unref(); // Allow parent to exit independently
      pid = child.pid;
    } else {
      // Open in terminal app (macOS)
      pid = await this.spawnInTerminal(cwd, command, terminalApp);
    }

    const entry: ProcessEntry = {
      pid,
      sessionId,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'starting',
      command,
    };

    this.registry.entries.push(entry);
    await this.saveRegistry();

    log.info({ pid, sessionId, terminalApp }, 'Process spawned');
    return entry;
  }

  /**
   * Spawn process in a terminal app (macOS)
   */
  private async spawnInTerminal(cwd: string, command: string[], terminalApp: TerminalApp): Promise<number> {
    const fullCommand = command.join(' ');

    // Escape single quotes for AppleScript
    const escapedCwd = cwd.replace(/'/g, "'\\''");
    const escapedCommand = fullCommand.replace(/'/g, "'\\''");

    let script: string;

    if (terminalApp === 'iterm2') {
      // iTerm2 AppleScript
      script = `
        tell application "iTerm"
          activate
          set newWindow to (create window with default profile)
          tell current session of newWindow
            write text "cd '${escapedCwd}' && ${escapedCommand}"
          end tell
        end tell
      `;
    } else {
      // Terminal.app AppleScript
      script = `
        tell application "Terminal"
          activate
          do script "cd '${escapedCwd}' && ${escapedCommand}"
        end tell
      `;
    }

    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
      log.info({ terminalApp, cwd }, 'Opened terminal window');

      // We can't get the PID directly from osascript, so return 0
      // The session will connect via socket and we'll track it then
      return 0;
    } catch (err) {
      log.error({ err, terminalApp }, 'Failed to open terminal');
      throw new Error(`Failed to open ${terminalApp}: ${(err as Error).message}`);
    }
  }

  /**
   * Kill a session process gracefully
   */
  async kill(sessionId: string, force = false): Promise<boolean> {
    const entry = await this.getEntry(sessionId);
    if (!entry) {
      log.warn({ sessionId }, 'Cannot kill - no entry found');
      return false;
    }

    const oldStatus = entry.status;
    entry.status = 'stopping';
    await this.saveRegistry();

    try {
      if (force) {
        process.kill(entry.pid, 'SIGKILL');
      } else {
        // Graceful: SIGINT -> wait -> SIGTERM -> wait -> SIGKILL
        process.kill(entry.pid, 'SIGINT');
        await this.waitForDeath(entry.pid, 5000);

        if (this.isProcessAlive(entry.pid)) {
          process.kill(entry.pid, 'SIGTERM');
          await this.waitForDeath(entry.pid, 3000);
        }

        if (this.isProcessAlive(entry.pid)) {
          process.kill(entry.pid, 'SIGKILL');
        }
      }

      entry.status = 'stopped';
      await this.saveRegistry();

      if (this.onStatusChange) {
        this.onStatusChange(entry, oldStatus);
      }

      log.info({ sessionId, pid: entry.pid }, 'Process killed');
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        // Process already dead
        entry.status = 'stopped';
        await this.saveRegistry();
        return true;
      }

      log.error({ err, sessionId }, 'Failed to kill process');
      throw err;
    }
  }

  /**
   * Wait for process to die
   */
  private async waitForDeath(pid: number, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (!this.isProcessAlive(pid)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Check if process is alive using signal 0
   * Returns false for PID 0 (unknown PID from manual sessions)
   */
  private isProcessAlive(pid: number): boolean {
    // PID 0 means unknown PID (manual session that didn't report its PID)
    if (pid === 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get entry by session ID
   */
  async getEntry(sessionId: string): Promise<ProcessEntry | undefined> {
    return this.registry.entries.find(e => e.sessionId === sessionId);
  }

  /**
   * Get entry by PID
   */
  async getEntryByPid(pid: number): Promise<ProcessEntry | undefined> {
    return this.registry.entries.find(e => e.pid === pid);
  }

  /**
   * Get all running sessions
   */
  async getAllRunning(): Promise<ProcessEntry[]> {
    return this.registry.entries.filter(
      e => e.status === 'running' || e.status === 'starting'
    );
  }

  /**
   * Get all entries (for status display)
   */
  getAllEntries(): ProcessEntry[] {
    return [...this.registry.entries];
  }

  /**
   * Get dead sessions that have threadId and need Discord notification
   * Used for startup reconciliation after bot restart
   */
  getDeadSessionsNeedingNotification(): ProcessEntry[] {
    return this.registry.entries.filter(
      e => (e.status === 'stopped' || e.status === 'orphaned') && e.threadId
    );
  }

  /**
   * Remove entry from registry (after cleanup is complete)
   */
  async removeEntry(sessionId: string): Promise<void> {
    const index = this.registry.entries.findIndex(e => e.sessionId === sessionId);
    if (index !== -1) {
      this.registry.entries.splice(index, 1);
      await this.saveRegistry();
      log.info({ sessionId }, 'Removed entry from registry');
    }
  }

  /**
   * Add a manually started session to registry
   * Called when a session connects but isn't tracked
   */
  async addManualSession(sessionId: string, cwd: string, pid?: number): Promise<ProcessEntry> {
    // Check if already exists
    const existing = this.registry.entries.find(e => e.sessionId === sessionId);
    if (existing) {
      return existing;
    }

    const entry: ProcessEntry = {
      pid: pid || 0, // 0 means unknown PID
      sessionId,
      cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      command: ['claude'], // Manual start, command unknown
    };

    this.registry.entries.push(entry);
    await this.saveRegistry();
    log.info({ sessionId, cwd }, 'Added manually started session to registry');

    return entry;
  }

  /**
   * Update entry status
   */
  async updateStatus(sessionId: string, status: ProcessEntry['status']): Promise<void> {
    const entry = this.registry.entries.find(e => e.sessionId === sessionId);
    if (entry) {
      const oldStatus = entry.status;
      entry.status = status;
      await this.saveRegistry();

      if (this.onStatusChange && oldStatus !== status) {
        this.onStatusChange(entry, oldStatus);
      }
    }
  }

  /**
   * Set thread ID for a session (called after Discord thread created)
   */
  async setThreadId(sessionId: string, threadId: string): Promise<void> {
    const entry = this.registry.entries.find(e => e.sessionId === sessionId);
    if (entry) {
      entry.threadId = threadId;
      await this.saveRegistry();
    }
  }

  /**
   * Run health check on all registered processes
   */
  async runHealthCheck(): Promise<void> {
    let changed = false;
    const now = Date.now();

    for (const entry of this.registry.entries) {
      const alive = this.isProcessAlive(entry.pid);
      const originalStatus = entry.status;

      // Skip already terminal states
      if (originalStatus === 'stopped' || originalStatus === 'orphaned') {
        entry.lastVerified = new Date().toISOString();
        continue;
      }

      // Safe date parsing with fallback
      const startedAt = new Date(entry.startedAt);
      const age = isNaN(startedAt.getTime()) ? Infinity : now - startedAt.getTime();

      // Handle 'starting' status specifically (fixes race condition)
      if (originalStatus === 'starting') {
        if (!alive) {
          // Process died before connecting
          entry.status = 'stopped';
          changed = true;
          log.warn({ sessionId: entry.sessionId, pid: entry.pid }, 'Process died during startup');
        } else if (age > 30000) {
          // Still alive but never connected - mark orphaned
          entry.status = 'orphaned';
          changed = true;
          log.warn({ sessionId: entry.sessionId, age }, 'Session startup timeout - never connected');
        }
      } else if (originalStatus === 'running') {
        if (!alive) {
          // Unexpected death while running
          entry.status = 'orphaned';
          changed = true;
          log.warn({ sessionId: entry.sessionId, pid: entry.pid }, 'Process died unexpectedly');
        }
      } else if (originalStatus === 'stopping') {
        if (!alive) {
          // Gracefully stopped
          entry.status = 'stopped';
          changed = true;
          log.info({ sessionId: entry.sessionId }, 'Process stopped gracefully');
        }
      }

      // Notify status change if any
      if (entry.status !== originalStatus && this.onStatusChange) {
        this.onStatusChange(entry, originalStatus);
      }

      entry.lastVerified = new Date().toISOString();
    }

    // Auto-cleanup orphaned processes if enabled
    const shouldAutoCleanup = this.getAutoCleanupOrphans?.() ?? true;
    if (shouldAutoCleanup) {
      for (const entry of this.registry.entries) {
        if (entry.status === 'orphaned' && this.isProcessAlive(entry.pid)) {
          log.info({ sessionId: entry.sessionId, pid: entry.pid }, 'Auto-killing orphaned process');
          try {
            process.kill(entry.pid, 'SIGKILL');
            entry.status = 'stopped';
            changed = true;
          } catch (err) {
            log.error({ err, pid: entry.pid }, 'Failed to kill orphaned process');
          }
        }
      }
    }

    // Clean up old stopped/orphaned entries (> 24 hours)
    const oldLength = this.registry.entries.length;
    this.registry.entries = this.registry.entries.filter(e => {
      if (e.status === 'stopped' || e.status === 'orphaned') {
        const startTime = new Date(e.startedAt).getTime();
        const entryAge = isNaN(startTime) ? Infinity : now - startTime;
        return entryAge < 24 * 60 * 60 * 1000;
      }
      return true;
    });

    if (this.registry.entries.length !== oldLength) {
      changed = true;
      log.info({ removed: oldLength - this.registry.entries.length }, 'Cleaned up old registry entries');
    }

    if (changed) {
      await this.saveRegistry();
    }
  }

  /**
   * Mark a session as being reconciled (prevents onSessionConnected from processing it)
   */
  markAsReconciling(sessionId: string): void {
    this.reconcilingSessionIds.add(sessionId);
  }

  /**
   * Unmark a session from reconciliation
   */
  unmarkAsReconciling(sessionId: string): void {
    this.reconcilingSessionIds.delete(sessionId);
  }

  /**
   * Called when session connects via socket - update status to running
   * Returns true if session was found in registry, false if it's a new/manual session
   */
  async onSessionConnected(sessionId: string, cwd?: string): Promise<{ found: boolean; entry?: ProcessEntry }> {
    // Skip sessions that are being reconciled (cleaned up after bot restart)
    if (this.reconcilingSessionIds.has(sessionId)) {
      log.info({ sessionId }, 'Session connect ignored - being reconciled');
      return { found: false };
    }

    const entry = this.registry.entries.find(e => e.sessionId === sessionId);

    // Session found in registry
    if (entry) {
      const oldStatus = entry.status;
      let statusChanged = false;

      // Transition from 'starting' to 'running'
      if (entry.status === 'starting') {
        entry.status = 'running';
        statusChanged = true;
        log.info({ sessionId }, 'Session connected (starting -> running)');
      } else if (entry.status === 'running') {
        // Already running - this is a reconnect after bot restart
        log.info({ sessionId }, 'Session reconnected');
      } else if (entry.status === 'orphaned') {
        // Was marked orphaned but reconnected - restore to running
        entry.status = 'running';
        statusChanged = true;
        log.info({ sessionId }, 'Orphaned session reconnected (orphaned -> running)');
      }

      // Always update lastVerified on connect
      entry.lastVerified = new Date().toISOString();
      await this.saveRegistry();

      if (statusChanged && this.onStatusChange) {
        this.onStatusChange(entry, oldStatus);
      }

      return { found: true, entry };
    }

    // Session not in registry - it's a manually started session
    log.info({ sessionId, cwd }, 'Session connected but not in registry (manual start)');
    return { found: false };
  }

  /**
   * Validate that a PID still corresponds to the expected session
   * Returns false if PID appears to have been reused by a different process
   */
  async validatePidOwnership(sessionId: string): Promise<boolean> {
    const entry = this.registry.entries.find(e => e.sessionId === sessionId);
    if (!entry) return false;

    // If process is dead, ownership is invalid
    if (!this.isProcessAlive(entry.pid)) {
      return false;
    }

    // For now, we trust the PID if it's alive.
    // A more robust check would involve the process writing its sessionId to a pidfile
    // or checking /proc/{pid}/cmdline on Linux for the --session-id argument.
    return true;
  }

  /**
   * Load registry from disk
   */
  private async loadRegistry(): Promise<void> {
    try {
      await access(REGISTRY_FILE);
      const content = await readFile(REGISTRY_FILE, 'utf-8');
      this.registry = JSON.parse(content);
      log.info({ entries: this.registry.entries.length }, 'Loaded process registry');
    } catch {
      this.registry = { version: 1, entries: [] };
      log.info('No existing process registry, starting fresh');
    }
  }

  /**
   * Save registry to disk
   * Returns true if save was successful, false otherwise
   */
  private async saveRegistry(): Promise<boolean> {
    try {
      await mkdir(dirname(REGISTRY_FILE), { recursive: true });
      await writeFile(REGISTRY_FILE, JSON.stringify(this.registry, null, 2));
      return true;
    } catch (err) {
      log.error({ err }, 'Failed to save process registry');
      // Re-throw for critical operations that need to know about failure
      // Callers can catch and handle appropriately
      return false;
    }
  }
}
