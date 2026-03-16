/**
 * Codex CLI session manager
 *
 * Wraps @openai/codex-sdk to manage Codex sessions.
 * Unlike Claude's PTY + socket + JSONL approach, Codex uses the SDK directly.
 */

import { Codex } from '@openai/codex-sdk';
import type { Thread, SandboxMode } from '@openai/codex-sdk';
import { randomUUID } from 'crypto';
import { discordLogger as log } from '../../utils/logger.js';

export const CODEX_MODEL = 'gpt-5.4';

export type { SandboxMode } from '@openai/codex-sdk';

export interface CodexSessionEntry {
  id: string;
  codexThread: Thread;
  codexThreadId: string;
  cwd: string;
  sandboxMode: SandboxMode;
  status: 'starting' | 'running' | 'idle' | 'ended';
  discordThreadId: string;
  startedAt: Date;
  activeTurn: AbortController | null;
}

export interface CodexEvents {
  onSessionStart: (sessionId: string, cwd: string, discordThreadId: string) => void | Promise<void>;
  onSessionEnd: (sessionId: string) => void;
  onSessionStatus: (sessionId: string, status: 'running' | 'idle' | 'ended') => void;
  onMessage: (sessionId: string, content: string) => void | Promise<void>;
  onCommandExecution: (sessionId: string, info: {
    command: string;
    status: string;
    output?: string;
    exitCode?: number;
    durationMs?: number;
  }) => void | Promise<void>;
  onFileChange: (sessionId: string, info: {
    changes: Array<{ path: string; kind: string; diff?: string }>;
    status: string;
  }) => void | Promise<void>;
  onError: (sessionId: string, error: Error) => void;
}

export class CodexSessionManager {
  private codex: Codex;
  private sessions = new Map<string, CodexSessionEntry>();
  private events: CodexEvents;
  private onCodexThreadIdSet?: (sessionId: string, codexThreadId: string) => void;

  constructor(events: CodexEvents, options?: {
    onCodexThreadIdSet?: (sessionId: string, codexThreadId: string) => void;
  }) {
    this.events = events;
    this.onCodexThreadIdSet = options?.onCodexThreadIdSet;
    this.codex = new Codex({
      config: {
        approval_policy: 'never',
      },
    });
  }

  async startSession(cwd: string, discordThreadId: string, options?: {
    sandboxMode?: SandboxMode;
  }): Promise<CodexSessionEntry> {
    const id = randomUUID();
    const sandboxMode = options?.sandboxMode ?? 'read-only';

    const codexThread = this.codex.startThread({
      model: CODEX_MODEL,
      workingDirectory: cwd,
      sandboxMode,
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    });

    const entry: CodexSessionEntry = {
      id,
      codexThread,
      codexThreadId: '', // Set after first turn
      cwd,
      sandboxMode,
      status: 'idle',
      discordThreadId,
      startedAt: new Date(),
      activeTurn: null,
    };

    this.sessions.set(id, entry);
    log.info({ sessionId: id, cwd, discordThreadId }, 'Codex session started');

    await this.events.onSessionStart(id, cwd, discordThreadId);
    return entry;
  }

  async sendInput(sessionId: string, prompt: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'ended') {
      log.error({ sessionId }, 'Codex session not found or ended');
      return false;
    }

    // Don't allow concurrent turns
    if (session.status === 'running') {
      log.warn({ sessionId }, 'Codex session is already processing a turn');
      return false;
    }

    // Fire and forget the streaming turn
    this.processStreamedTurn(session, prompt).catch((err) => {
      log.error({ sessionId, err }, 'Codex streamed turn failed');
      this.events.onError(sessionId, err);
    });

    return true;
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Abort active turn if running
    if (session.activeTurn) {
      session.activeTurn.abort();
      session.activeTurn = null;
    }

    session.status = 'ended';
    this.sessions.delete(sessionId);
    this.events.onSessionEnd(sessionId);
    log.info({ sessionId }, 'Codex session stopped');
    return true;
  }

  /**
   * Interrupt (abort) the active turn without ending the session
   */
  interruptSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.activeTurn) {
      // Only abort — don't set activeTurn=null or status=idle here.
      // processStreamedTurn's finally block will handle cleanup after
      // the stream fully unwinds, preventing a concurrent turn window.
      session.activeTurn.abort();
      log.info({ sessionId }, 'Codex session interrupted');
      return true;
    }

    return false; // Nothing to interrupt
  }

  getSession(sessionId: string): CodexSessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByDiscordThread(discordThreadId: string): CodexSessionEntry | undefined {
    for (const session of this.sessions.values()) {
      if (session.discordThreadId === discordThreadId) return session;
    }
    return undefined;
  }

  getAllSessions(): CodexSessionEntry[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Switch sandbox mode for a running session by replacing the Thread object.
   * Aborts active turn if running, then resumes (or recreates) the thread with the new mode.
   */
  async switchSandboxMode(sessionId: string, newMode: SandboxMode): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'ended') return false;
    if (session.sandboxMode === newMode) return true; // Already in desired mode

    // Abort active turn if running
    if (session.activeTurn) {
      session.activeTurn.abort();
      session.activeTurn = null;
    }

    const threadOptions = {
      model: CODEX_MODEL,
      workingDirectory: session.cwd,
      sandboxMode: newMode,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
    };

    if (session.codexThreadId) {
      // Resume existing thread with new sandbox mode
      session.codexThread = this.codex.resumeThread(session.codexThreadId, threadOptions);
    } else {
      // No thread ID yet (pre-first-turn) — create a new thread
      session.codexThread = this.codex.startThread(threadOptions);
    }

    session.sandboxMode = newMode;
    session.status = 'idle';
    log.info({ sessionId, newMode }, 'Codex sandbox mode switched');
    return true;
  }

  /**
   * Restore sessions from persisted mappings (after PM2 restart)
   */
  async restoreSessions(mappings: Array<{
    sessionId: string;
    codexThreadId: string;
    cwd: string;
    discordThreadId: string;
  }>): Promise<number> {
    let restored = 0;
    for (const m of mappings) {
      if (!m.codexThreadId) {
        log.warn({ sessionId: m.sessionId }, 'Skipping restore: no Codex thread ID');
        continue;
      }

      try {
        const codexThread = this.codex.resumeThread(m.codexThreadId, {
          model: CODEX_MODEL,
          skipGitRepoCheck: true,
        });

        const entry: CodexSessionEntry = {
          id: m.sessionId,
          codexThread,
          codexThreadId: m.codexThreadId,
          cwd: m.cwd,
          sandboxMode: 'read-only',
          status: 'idle',
          discordThreadId: m.discordThreadId,
          startedAt: new Date(),
          activeTurn: null,
        };

        this.sessions.set(m.sessionId, entry);
        restored++;
        log.info({ sessionId: m.sessionId, codexThreadId: m.codexThreadId }, 'Restored Codex session');
      } catch (err) {
        log.error({ sessionId: m.sessionId, err }, 'Failed to restore Codex session');
      }
    }
    return restored;
  }

  private async processStreamedTurn(session: CodexSessionEntry, prompt: string): Promise<void> {
    session.status = 'running';
    this.events.onSessionStatus(session.id, 'running');

    const abortController = new AbortController();
    session.activeTurn = abortController;

    try {
      const { events } = await session.codexThread.runStreamed(prompt, {
        signal: abortController.signal,
      });

      for await (const event of events) {
        // Check if aborted
        if (abortController.signal.aborted) break;

        switch (event.type) {
          case 'thread.started': {
            const threadId = (event as any).thread_id;
            if (threadId && !session.codexThreadId) {
              session.codexThreadId = threadId;
              log.info({ sessionId: session.id, codexThreadId: threadId }, 'Codex thread ID set');
              // Persist the thread ID for session restoration
              this.onCodexThreadIdSet?.(session.id, threadId);
            }
            break;
          }

          case 'item.completed': {
            const item = (event as any).item;
            if (!item) break;

            switch (item.type) {
              case 'agent_message':
                if (item.text) {
                  await this.events.onMessage(session.id, item.text);
                }
                break;

              case 'command_execution':
                await this.events.onCommandExecution(session.id, {
                  command: item.command || '',
                  status: item.status || 'completed',
                  output: item.aggregated_output,
                  exitCode: item.exit_code,
                  durationMs: item.duration_ms,
                });
                break;

              case 'file_change':
                if (item.changes) {
                  await this.events.onFileChange(session.id, {
                    changes: item.changes.map((c: any) => ({
                      path: c.path || '',
                      kind: c.kind || 'unknown',
                      diff: c.diff,
                    })),
                    status: item.status || 'completed',
                  });
                }
                break;

              default:
                log.debug({ sessionId: session.id, itemType: item.type }, 'Unhandled Codex item type');
                break;
            }
            break;
          }

          case 'turn.completed': {
            const usage = (event as any).usage;
            log.info({
              sessionId: session.id,
              inputTokens: usage?.input_tokens,
              outputTokens: usage?.output_tokens,
            }, 'Codex turn completed');
            break;
          }

          case 'error': {
            log.error({ sessionId: session.id, error: event }, 'Codex stream error');
            this.events.onError(session.id, new Error(String(event)));
            break;
          }
        }
      }
    } finally {
      // Only reset state if this turn's controller is still the active one.
      // switchSandboxMode() replaces activeTurn, so a stale finally must not overwrite.
      if (session.activeTurn === abortController) {
        session.activeTurn = null;
      }
      if (this.sessions.has(session.id) && session.activeTurn === null) {
        session.status = 'idle';
        this.events.onSessionStatus(session.id, 'idle');
      }
    }
  }
}
