/**
 * Codex CLI session manager
 *
 * Wraps @openai/codex-sdk to manage Codex sessions.
 * Unlike Claude's PTY + socket + JSONL approach, Codex uses the SDK directly.
 */

import { Codex } from '@openai/codex-sdk';
import type { Thread, SandboxMode, ModelReasoningEffort } from '@openai/codex-sdk';
import { randomUUID } from 'crypto';
import { discordLogger as log } from '../../utils/logger.js';

/**
 * Default Codex model. Updated to gpt-5.5 (frontier) — `~/.codex/config.toml`
 * defaults to this and `models_cache.json` lists it as the recommended model.
 * Per-session override is supported via `startSession({ model, modelReasoningEffort })`
 * so /codex start can pin a specific model + reasoning level.
 */
export const CODEX_MODEL = 'gpt-5.5';
export const CODEX_DEFAULT_REASONING: ModelReasoningEffort = 'high';

/**
 * Idle watchdog thresholds for Codex stream silent-hang detection.
 *
 * Background: a Codex CLI subprocess can wedge in `STAT=S` (interruptible
 * sleep, waiting on a network socket) after `thread.started` fires. The Node
 * side blocks forever on `for await (const event of events)` because no JSON
 * line ever arrives on stdout. Without this watchdog the session stays
 * `running` indefinitely (observed: 8h+ silent hang).
 *
 * Strategy:
 *   - Tick the watchdog while a turn is in flight.
 *   - At WARN_MS of silence: log a structured warning with the last-known
 *     event type/age so the operator can correlate from `/check-alive`.
 *   - At ABORT_MS of silence: abort the AbortController. The for-await loop
 *     unwinds via `signal.aborted`, the finally block returns the session
 *     to `idle`, and the user can retry.
 *
 * These intervals deliberately err toward "let the model think" — gpt-5.5
 * with `model_reasoning_effort=high` legitimately spends several minutes on
 * heavy reasoning before emitting tokens, so we don't want false positives
 * that interrupt healthy long turns.
 */
const CODEX_IDLE_WARN_MS = 90_000;       // 1.5 min — log warning
const CODEX_IDLE_ABORT_MS = 600_000;     // 10 min — force abort
const CODEX_WATCHDOG_TICK_MS = 30_000;   // check cadence

export type { SandboxMode, ModelReasoningEffort } from '@openai/codex-sdk';

export interface CodexSessionEntry {
  id: string;
  codexThread: Thread;
  codexThreadId: string;
  cwd: string;
  sandboxMode: SandboxMode;
  /** Model slug pinned at /codex start time (e.g. `gpt-5.5`). Preserved
   *  across sandbox switch + restore so the user's selection sticks. */
  model: string;
  /** Reasoning effort pinned at /codex start time. */
  modelReasoningEffort: ModelReasoningEffort;
  status: 'starting' | 'running' | 'idle' | 'ended';
  discordThreadId: string;
  startedAt: Date;
  activeTurn: AbortController | null;
  turnCount: number;
  /**
   * Pending user messages received while a turn was in flight (Claude-style queueing).
   * Drained after the active turn ends — all queued messages are joined with `\n\n`
   * and sent as ONE follow-up turn so multi-message input doesn't burn N turns.
   * Cap = `maxQueueLength` to bound memory + protect against runaway senders.
   */
  inputQueue: string[];
  maxQueueLength: number;
  /**
   * Liveness telemetry — updated every time the SDK emits a stream event, plus
   * baseline-set at session creation. `/check-alive` reads these and the
   * idle watchdog uses them to detect silent CLI hangs (the case that
   * triggered this logging: thread.started fired then 8h of dead air).
   */
  lastEventAt: Date;
  lastEventType: string | null;
  /** Total stream events received this session (sanity counter). */
  eventsTotal: number;
  /** Wall-clock time the current turn was kicked off — used to age-out
   *  sessions that received `runStreamed()` but never produced any event. */
  turnStartedAt: Date | null;
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
  onTurnComplete?: (sessionId: string, usage: { inputTokens: number; outputTokens: number }, turnNumber: number) => void | Promise<void>;
}

export class CodexSessionManager {
  private codex: Codex;
  private sessions = new Map<string, CodexSessionEntry>();
  private events: CodexEvents;
  private onCodexThreadIdSet?: (sessionId: string, codexThreadId: string) => void;
  private maxQueueLength: number;

  constructor(events: CodexEvents, options?: {
    onCodexThreadIdSet?: (sessionId: string, codexThreadId: string) => void;
    /** Per-session queue cap. Defaults to 10 to match Claude SDK manager. */
    maxQueueLength?: number;
  }) {
    this.events = events;
    this.onCodexThreadIdSet = options?.onCodexThreadIdSet;
    this.maxQueueLength = options?.maxQueueLength ?? 10;
    this.codex = new Codex({
      config: {
        approval_policy: 'never',
      },
    });
  }

  async startSession(cwd: string, discordThreadId: string, options?: {
    sandboxMode?: SandboxMode;
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
    /** Pre-generated session ID. When the caller needs to create the Discord
     *  channel/thread + post the start message BEFORE the SDK session exists,
     *  it generates the UUID up front, passes it to `createCodexSession()`,
     *  then forwards the same value here so both sides agree on the ID and
     *  the start message can render the real 8-char prefix instead of the
     *  legacy `'pending'` placeholder. */
    sessionId?: string;
  }): Promise<CodexSessionEntry> {
    const id = options?.sessionId ?? randomUUID();
    const sandboxMode = options?.sandboxMode ?? 'read-only';
    const model = options?.model ?? CODEX_MODEL;
    const modelReasoningEffort = options?.modelReasoningEffort ?? CODEX_DEFAULT_REASONING;

    const codexThread = this.codex.startThread({
      model,
      modelReasoningEffort,
      workingDirectory: cwd,
      sandboxMode,
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    });

    const now = new Date();
    const entry: CodexSessionEntry = {
      id,
      codexThread,
      codexThreadId: '', // Set after first turn
      cwd,
      sandboxMode,
      model,
      modelReasoningEffort,
      status: 'idle',
      discordThreadId,
      startedAt: now,
      activeTurn: null,
      turnCount: 0,
      inputQueue: [],
      maxQueueLength: this.maxQueueLength,
      lastEventAt: now,
      lastEventType: null,
      eventsTotal: 0,
      turnStartedAt: null,
    };

    this.sessions.set(id, entry);
    log.info({ sessionId: id, cwd, discordThreadId, model, modelReasoningEffort }, 'Codex session started');

    await this.events.onSessionStart(id, cwd, discordThreadId);
    return entry;
  }

  async sendInput(sessionId: string, prompt: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'ended') {
      log.error({ sessionId }, 'Codex session not found or ended');
      return false;
    }

    // Reject only when the queue is full — otherwise we always queue and let
    // tryDrainQueue (here or in processStreamedTurn's finally) decide when to
    // run. This matches the Claude SDK manager's "never drop input" contract.
    if (session.inputQueue.length >= session.maxQueueLength) {
      log.warn({
        sessionId,
        queueLen: session.inputQueue.length,
        max: session.maxQueueLength,
      }, 'Codex input queue full, dropping message');
      return false;
    }

    session.inputQueue.push(prompt);
    log.debug({ sessionId, queueLen: session.inputQueue.length, status: session.status }, 'Codex input queued');

    // If no turn is currently in flight, drain immediately. Otherwise the
    // active turn's `finally` will drain the queue once it ends.
    this.tryDrainQueue(session);
    return true;
  }

  /**
   * If a turn isn't already running, pop ALL queued messages, merge them with
   * `\n\n`, and start a new streamed turn. Merging matches the Claude SDK
   * pattern — multi-message bursts become one Codex turn instead of N turns.
   *
   * Safe to call any time — if a turn is in flight or session ended, no-op.
   */
  private tryDrainQueue(session: CodexSessionEntry): void {
    if (session.status === 'ended') return;
    if (session.activeTurn !== null) return; // Turn in flight; finally will drain
    if (session.inputQueue.length === 0) return;

    const merged = session.inputQueue.splice(0).join('\n\n');
    log.info({
      sessionId: session.id,
      mergedFrom: merged.split('\n\n').length,
      lengthChars: merged.length,
    }, 'Draining Codex input queue');

    this.processStreamedTurn(session, merged).catch((err) => {
      log.error({ sessionId: session.id, err }, 'Codex streamed turn failed');
      this.events.onError(session.id, err);
    });
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Abort active turn if running
    if (session.activeTurn) {
      session.activeTurn.abort();
      session.activeTurn = null;
    }

    // Drop any queued input — session is ending, no point delivering them.
    const dropped = session.inputQueue.length;
    if (dropped > 0) {
      log.warn({ sessionId, dropped }, 'Discarding queued Codex input on stop');
      session.inputQueue.length = 0;
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

    // Preserve the user's pinned model + reasoning effort across sandbox switches.
    const threadOptions = {
      model: session.model,
      modelReasoningEffort: session.modelReasoningEffort,
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
    log.info({ sessionId, newMode, model: session.model, modelReasoningEffort: session.modelReasoningEffort }, 'Codex sandbox mode switched');
    return true;
  }

  /**
   * Switch reasoning effort on the fly without ending the session.
   * Aborts the active turn (if any), then resumes (or recreates) the Codex
   * thread with the new effort. Conversation context is preserved via
   * resumeThread() once the first turn has assigned `codexThreadId`.
   *
   * Returns:
   *   - true  if the switch succeeded (or was a no-op because already at newEffort)
   *   - false if the session is missing or ended
   */
  async switchReasoningEffort(sessionId: string, newEffort: ModelReasoningEffort): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'ended') return false;
    if (session.modelReasoningEffort === newEffort) return true; // No-op

    // Abort active turn if running — same pattern as switchSandboxMode.
    if (session.activeTurn) {
      session.activeTurn.abort();
      session.activeTurn = null;
    }

    const threadOptions = {
      model: session.model,
      modelReasoningEffort: newEffort,
      workingDirectory: session.cwd,
      sandboxMode: session.sandboxMode,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
    };

    if (session.codexThreadId) {
      // Resume existing thread with new reasoning effort
      session.codexThread = this.codex.resumeThread(session.codexThreadId, threadOptions);
    } else {
      // No thread ID yet (pre-first-turn) — create a new thread
      session.codexThread = this.codex.startThread(threadOptions);
    }

    session.modelReasoningEffort = newEffort;
    session.status = 'idle';
    log.info({ sessionId, newEffort, model: session.model, sandboxMode: session.sandboxMode }, 'Codex reasoning effort switched');
    return true;
  }

  /**
   * Restore sessions from persisted mappings (after PM2 restart).
   * Preserves the user's selected model + reasoning effort when stored;
   * falls back to defaults for legacy mappings (pre-model-selection feature).
   */
  async restoreSessions(mappings: Array<{
    sessionId: string;
    codexThreadId: string;
    cwd: string;
    discordThreadId: string;
    model?: string;
    modelReasoningEffort?: ModelReasoningEffort;
  }>): Promise<number> {
    let restored = 0;
    for (const m of mappings) {
      if (!m.codexThreadId) {
        log.warn({ sessionId: m.sessionId }, 'Skipping restore: no Codex thread ID');
        continue;
      }

      const model = m.model ?? CODEX_MODEL;
      const modelReasoningEffort = m.modelReasoningEffort ?? CODEX_DEFAULT_REASONING;

      try {
        // CRITICAL: must pass `workingDirectory` here. Without it the Codex CLI
        // falls back to `process.cwd()` of the bot (typically sleep-code under
        // PM2), so subsequent turns operate in the wrong directory after a
        // restart. session.cwd in memory is correct, but the actual CLI subprocess
        // is what matters for tool calls. Match other Thread option call sites
        // (switchSandboxMode, switchReasoningEffort) for consistency.
        const codexThread = this.codex.resumeThread(m.codexThreadId, {
          model,
          modelReasoningEffort,
          workingDirectory: m.cwd,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          skipGitRepoCheck: true,
        });

        const restoredAt = new Date();
        const entry: CodexSessionEntry = {
          id: m.sessionId,
          codexThread,
          codexThreadId: m.codexThreadId,
          cwd: m.cwd,
          sandboxMode: 'read-only',
          model,
          modelReasoningEffort,
          status: 'idle',
          discordThreadId: m.discordThreadId,
          startedAt: restoredAt,
          activeTurn: null,
          turnCount: 0,
          inputQueue: [],
          maxQueueLength: this.maxQueueLength,
          lastEventAt: restoredAt,
          lastEventType: null,
          eventsTotal: 0,
          turnStartedAt: null,
        };

        this.sessions.set(m.sessionId, entry);
        restored++;
        log.info({ sessionId: m.sessionId, codexThreadId: m.codexThreadId, model, modelReasoningEffort }, 'Restored Codex session');
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
    const turnStart = new Date();
    session.turnStartedAt = turnStart;
    session.lastEventAt = turnStart;
    session.lastEventType = null;

    log.info({
      sessionId: session.id,
      codexThreadId: session.codexThreadId || '(pre-thread.started)',
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 80),
      model: session.model,
      modelReasoningEffort: session.modelReasoningEffort,
      sandboxMode: session.sandboxMode,
      cwd: session.cwd,
    }, 'Codex stream starting');

    // ── Idle watchdog ─────────────────────────────────────────────────
    // Checks every CODEX_WATCHDOG_TICK_MS whether the stream has gone
    // quiet. Fires structured warnings at WARN_MS and aborts at ABORT_MS.
    // See the constants block at the top of this file for the rationale.
    let warnedOnce = false;
    const watchdogHandle = setInterval(() => {
      if (abortController.signal.aborted) return;
      const idleMs = Date.now() - session.lastEventAt.getTime();
      const turnElapsedMs = Date.now() - turnStart.getTime();

      if (idleMs >= CODEX_IDLE_ABORT_MS) {
        log.error({
          sessionId: session.id,
          codexThreadId: session.codexThreadId,
          lastEventType: session.lastEventType,
          eventsTotal: session.eventsTotal,
          idleMs,
          idleSec: Math.round(idleMs / 1000),
          turnElapsedSec: Math.round(turnElapsedMs / 1000),
          abortThresholdMs: CODEX_IDLE_ABORT_MS,
        }, 'Codex stream silent-hang abort threshold reached, forcing abort');
        abortController.abort();
        try {
          this.events.onError(session.id, new Error(
            `Codex stream silent-hang: no events for ${Math.round(idleMs / 1000)}s ` +
            `(last event: ${session.lastEventType ?? 'none'}). Forced abort. ` +
            `Try sending the message again, or /codex stop and start a fresh session.`,
          ));
        } catch (err) {
          log.error({ err, sessionId: session.id }, 'Failed to emit silent-hang onError');
        }
      } else if (idleMs >= CODEX_IDLE_WARN_MS && !warnedOnce) {
        warnedOnce = true;
        log.warn({
          sessionId: session.id,
          codexThreadId: session.codexThreadId,
          lastEventType: session.lastEventType,
          eventsTotal: session.eventsTotal,
          idleMs,
          idleSec: Math.round(idleMs / 1000),
          turnElapsedSec: Math.round(turnElapsedMs / 1000),
          warnThresholdMs: CODEX_IDLE_WARN_MS,
          abortThresholdMs: CODEX_IDLE_ABORT_MS,
        }, 'Codex stream idle warning — possible silent hang');
      }
    }, CODEX_WATCHDOG_TICK_MS);
    // Don't keep the event loop alive solely for the watchdog timer.
    if (typeof watchdogHandle.unref === 'function') watchdogHandle.unref();

    let runStreamedResolved = false;
    try {
      const { events } = await session.codexThread.runStreamed(prompt, {
        signal: abortController.signal,
      });
      runStreamedResolved = true;
      log.info({
        sessionId: session.id,
        codexThreadId: session.codexThreadId,
        runStreamedMs: Date.now() - turnStart.getTime(),
      }, 'Codex stream connected, awaiting first event');

      for await (const event of events) {
        // Check if aborted
        if (abortController.signal.aborted) {
          log.info({
            sessionId: session.id,
            codexThreadId: session.codexThreadId,
            eventsTotal: session.eventsTotal,
            lastEventType: session.lastEventType,
          }, 'Codex stream loop exited due to abort signal');
          break;
        }

        // ── Liveness telemetry ──────────────────────────────────────
        // Record the timestamp + event type FIRST so the watchdog and
        // /check-alive see fresh data even if the handler below throws.
        const eventArrivedAt = new Date();
        const idleSinceLastSec = Math.round(
          (eventArrivedAt.getTime() - session.lastEventAt.getTime()) / 1000,
        );
        session.lastEventAt = eventArrivedAt;
        session.lastEventType = event.type;
        session.eventsTotal++;
        log.debug({
          sessionId: session.id,
          eventType: event.type,
          eventIndex: session.eventsTotal,
          idleSinceLastSec,
        }, 'Codex event received');

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
            session.turnCount++;
            log.info({
              sessionId: session.id,
              inputTokens: usage?.input_tokens,
              outputTokens: usage?.output_tokens,
              turn: session.turnCount,
              turnDurationSec: Math.round((Date.now() - turnStart.getTime()) / 1000),
              eventsTotal: session.eventsTotal,
            }, 'Codex turn completed');
            if (usage) {
              await this.events.onTurnComplete?.(session.id, {
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
              }, session.turnCount);
            }
            break;
          }

          case 'error': {
            const errEvent = event as any;
            const errMessage = errEvent?.message || errEvent?.error?.message || errEvent?.error || JSON.stringify(event);
            log.error({ sessionId: session.id, error: errEvent }, 'Codex stream error');
            this.events.onError(session.id, new Error(String(errMessage)));
            break;
          }
        }
      }

      log.info({
        sessionId: session.id,
        codexThreadId: session.codexThreadId,
        eventsTotal: session.eventsTotal,
        lastEventType: session.lastEventType,
        turnDurationMs: Date.now() - turnStart.getTime(),
      }, 'Codex stream loop exited normally');
    } catch (err) {
      log.error({
        sessionId: session.id,
        codexThreadId: session.codexThreadId,
        runStreamedResolved,
        eventsTotal: session.eventsTotal,
        lastEventType: session.lastEventType,
        turnDurationMs: Date.now() - turnStart.getTime(),
        err,
      }, 'Codex stream loop threw');
      throw err;
    } finally {
      clearInterval(watchdogHandle);
      session.turnStartedAt = null;
      // Only reset state if this turn's controller is still the active one.
      // switchSandboxMode() replaces activeTurn, so a stale finally must not overwrite.
      if (session.activeTurn === abortController) {
        session.activeTurn = null;
      }
      if (this.sessions.has(session.id) && session.activeTurn === null) {
        session.status = 'idle';
        this.events.onSessionStatus(session.id, 'idle');

        // Drain any messages queued during this turn (e.g. user kept typing
        // mid-response, or sent /interrupt + new prompt). setImmediate avoids
        // re-entering processStreamedTurn from inside its own finally and gives
        // the event loop a tick before the next runStreamed() call.
        if (session.inputQueue.length > 0) {
          setImmediate(() => this.tryDrainQueue(session));
        }
      }
    }
  }
}
