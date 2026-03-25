import { randomUUID } from 'crypto';
import {
  query,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { discordLogger as log } from '../../utils/logger.js';
import type { ClaudeTransport } from '../claude-transport.js';
import type { DiscordState } from '../state.js';

const END_SENTINEL = Symbol('claude-sdk-end');
type EndSentinel = typeof END_SENTINEL;

export interface ClaudeSdkSessionEntry {
  id: string;
  sdkSessionId: string;
  cwd: string;
  discordThreadId: string;
  status: 'idle' | 'running' | 'ended';
  startedAt: Date;
  sessionAbortController: AbortController;
  turnAbortController: AbortController;
  pendingInputResolve: ((text: string | EndSentinel) => void) | null;
  inputQueue: string[];
  maxQueueLength: number;
  pendingPermissions: Map<string, { resolve: Function; toolName: string; input: unknown }>;
  activeQuery: Query | null;
  interrupted: boolean;
  transport: ClaudeTransport;
  lastAssistantUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
}

export interface ClaudeSdkToolCallInfo {
  toolName: string;
  input: unknown;
  toolUseId?: string | null;
}

export interface ClaudeSdkToolResultInfo {
  summary: string;
  toolUseIds: string[];
}

export interface ClaudeSdkTurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  totalCostUSD: number;
  contextWindow: number;
  numTurns: number;
}

export interface ClaudeSdkEvents {
  onSessionStart: (sessionId: string, cwd: string, discordThreadId: string) => void | Promise<void>;
  onSessionEnd: (sessionId: string) => void | Promise<void>;
  onSessionStatus?: (sessionId: string, status: 'running' | 'idle' | 'ended') => void | Promise<void>;
  onMessage: (sessionId: string, content: string) => void | Promise<void>;
  onToolCall: (sessionId: string, info: ClaudeSdkToolCallInfo) => void | Promise<void>;
  onToolResult: (sessionId: string, info: ClaudeSdkToolResultInfo) => void | Promise<void>;
  onError: (sessionId: string, error: Error) => void | Promise<void>;
  onPermissionRequest?: (sessionId: string, request: { requestId: string; toolName: string; toolInput: Record<string, unknown> }) => void | Promise<void>;
  onYoloApprove?: (sessionId: string, toolName: string) => void | Promise<void>;
  onPermissionTimeout?: (sessionId: string, requestId: string, toolName: string) => void | Promise<void>;
  onSdkSessionIdUpdate?: (sessionId: string, sdkSessionId: string) => void | Promise<void>;
  onTurnComplete?: (sessionId: string, usage: ClaudeSdkTurnUsage) => void | Promise<void>;
  onAskUserQuestion?: (sessionId: string, requestId: string, questions: any[]) => void | Promise<void>;
}

const YOLO_EXCLUDED_TOOLS = new Set(['ExitPlanMode']);

// When true, processQueryStream treats stream end as expected (no error, no archive)
let shuttingDown = false;
const DEFAULT_PERMISSION_TIMEOUT_MS = 0; // 0 = no timeout (wait indefinitely)

export class ClaudeSdkSessionManager {
  private sessions = new Map<string, ClaudeSdkSessionEntry>();
  private events: ClaudeSdkEvents;
  private state: DiscordState;
  private maxQueueLength: number;
  private permissionTimeoutMs: number;

  constructor(events: ClaudeSdkEvents, state: DiscordState, options?: { maxQueueLength?: number; permissionTimeoutMs?: number }) {
    this.events = events;
    this.state = state;
    this.maxQueueLength = options?.maxQueueLength ?? 10;
    this.permissionTimeoutMs = options?.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  }

  async startSession(
    cwd: string,
    discordThreadId: string,
    options?: { model?: string; sessionId?: string; resume?: string },
  ): Promise<ClaudeSdkSessionEntry> {
    const id = options?.sessionId ?? randomUUID();

    // Guard: reuse existing live session by ID
    const existingById = this.sessions.get(id);
    if (existingById && existingById.status !== 'ended') {
      log.warn({ sessionId: id, status: existingById.status, pid: process.pid }, 'startSession: reusing existing live session by ID');
      return existingById;
    }

    // Guard: reuse existing live session by thread
    const existingByThread = this.getSessionByThread(discordThreadId);
    if (existingByThread && existingByThread.status !== 'ended') {
      log.warn({ sessionId: existingByThread.id, threadId: discordThreadId, pid: process.pid }, 'startSession: reusing existing live session by thread');
      return existingByThread;
    }

    const entry = this.createEntry(id, cwd, discordThreadId);

    // When resuming, sdkSessionId must match the SDK session we're resuming
    // so query() sends the correct sessionId that Claude Code recognises.
    // For fresh starts, generate a new UUID to avoid collisions with stale state.
    if (options?.resume) {
      entry.sdkSessionId = options.resume;
    } else {
      entry.sdkSessionId = randomUUID();
    }

    this.sessions.set(id, entry);

    await this.events.onSessionStart(id, cwd, discordThreadId);

    // Start the query stream in the background.
    // SDK only produces messages after user input arrives via the prompt generator,
    // so we don't wait for a "first message" — just let it run.
    // Stream errors are caught here and forwarded to the error handler.
    this.processQueryStream(entry, {
      model: options?.model,
      resume: options?.resume,
    }).catch(async (err) => {
      log.error({ sessionId: id, err }, 'Claude SDK session stream failed');
      await this.events.onError(id, err as Error);
      await this.finalizeSession(entry, true);
    });

    if (options?.resume) {
      log.info({ sessionId: id, sdkSessionId: entry.sdkSessionId, threadId: discordThreadId, resume: options.resume, pid: process.pid }, 'SDK session resumed');
    } else {
      log.info({ sessionId: id, sdkSessionId: entry.sdkSessionId, threadId: discordThreadId, pid: process.pid }, 'SDK session started (fresh)');
    }

    return entry;
  }

  sendInput(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'ended') {
      return false;
    }

    if (session.pendingInputResolve) {
      session.pendingInputResolve(text);
      session.pendingInputResolve = null;
      return true;
    }

    if (session.inputQueue.length >= session.maxQueueLength) {
      return false;
    }

    session.inputQueue.push(text);
    return true;
  }

  interruptSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'ended') {
      return false;
    }

    session.interrupted = true;
    session.turnAbortController.abort();
    void session.activeQuery?.interrupt().catch((err) => {
      log.warn({ sessionId, err }, 'Failed to interrupt Claude SDK query');
    });
    return true;
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'ended') {
      return false;
    }

    session.status = 'ended';
    await this.events.onSessionStatus?.(session.id, 'ended');

    if (session.pendingInputResolve) {
      session.pendingInputResolve(END_SENTINEL);
      session.pendingInputResolve = null;
    }

    // Cleanup pending permissions — deny all outstanding
    for (const [reqId, perm] of session.pendingPermissions) {
      (perm.resolve as Function)({ behavior: 'deny', message: 'Session ended' });
      this.state.pendingPermissions.delete(reqId);
    }
    session.pendingPermissions.clear();

    session.inputQueue.length = 0;
    session.turnAbortController.abort();
    session.sessionAbortController.abort();
    try { session.activeQuery?.close(); } catch { /* ignore close errors after abort */ }

    // Small delay to let processQueryStream finally block run first
    await new Promise(resolve => setTimeout(resolve, 200));
    // finalizeSession may already have been called by processQueryStream's finally block
    if (this.sessions.has(session.id)) {
      await this.finalizeSession(session, true);
    }
    return true;
  }

  getSession(sessionId: string): ClaudeSdkSessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByThread(discordThreadId: string): ClaudeSdkSessionEntry | undefined {
    for (const session of this.sessions.values()) {
      if (session.discordThreadId === discordThreadId) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Graceful shutdown: close all sessions without archiving persisted mappings.
   * This preserves sdk-session-mappings.json so lazy resume works after restart.
   */
  async shutdown(): Promise<void> {
    shuttingDown = true;

    for (const session of this.sessions.values()) {
      session.status = 'ended';
      if (session.pendingInputResolve) {
        session.pendingInputResolve(END_SENTINEL);
        session.pendingInputResolve = null;
      }
      session.turnAbortController.abort();
      session.sessionAbortController.abort();
      session.activeQuery?.close();
    }

    // Give streams a moment to settle
    await new Promise(r => setTimeout(r, 500));
    this.sessions.clear();
  }

  getAllSessions(): ClaudeSdkSessionEntry[] {
    return Array.from(this.sessions.values());
  }

  private async handleCanUseTool(
    session: ClaudeSdkSessionEntry,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string }> {
    log.info({ sessionId: session.id, toolName, input: JSON.stringify(input).slice(0, 500), pid: process.pid }, 'canUseTool: full input');

    // AskUserQuestion: show interactive UI and wait for user answer
    if (toolName === 'AskUserQuestion' && input.questions) {
      return new Promise((resolve) => {
        const requestId = randomUUID();

        // Store resolve so button/select handlers can call it with answers
        this.state.sdkAskQuestionResolvers.set(requestId, (answers: Record<string, string>) => {
          this.state.sdkAskQuestionResolvers.delete(requestId);
          // Merge answers into the original input
          const updatedQuestions = (input.questions as any[]).map((q: any, idx: number) => ({
            ...q,
            answer: answers[String(idx)] || '',
          }));
          resolve({ behavior: 'allow', updatedInput: { ...input, questions: updatedQuestions } });
        });

        // Send question UI to Discord
        this.events.onAskUserQuestion?.(session.id, requestId, input.questions as any[]);
      });
    }

    // Log Agent/Task tool input for debugging subagent display
    if (toolName === 'Task' || toolName === 'Agent') {
      log.info({ sessionId: session.id, tool: toolName, inputKeys: Object.keys(input), subagentType: input.subagent_type, description: input.description, hasPrompt: !!input.prompt }, 'SDK canUseTool: Agent/Task');
    }

    // YOLO mode: auto-approve (except excluded tools)
    if (this.state.yoloSessions.has(session.id) && !YOLO_EXCLUDED_TOOLS.has(toolName)) {
      log.info({ sessionId: session.id, tool: toolName }, 'SDK YOLO: auto-approving');
      await this.events.onYoloApprove?.(session.id, toolName);
      return { behavior: 'allow', updatedInput: input };
    }

    // Create Promise with wrappedResolve for dual-map cleanup
    return new Promise((resolve) => {
      const requestId = randomUUID();
      let resolved = false;

      const wrappedResolve = (decision: { behavior: 'allow' | 'deny'; message?: string }) => {
        if (resolved) return;
        resolved = true;
        this.state.pendingPermissions.delete(requestId);
        session.pendingPermissions.delete(requestId);

        if (decision.behavior === 'allow') {
          resolve({ behavior: 'allow', updatedInput: input });
        } else {
          resolve({ behavior: 'deny', message: decision.message || 'Permission denied' });
        }
      };

      // Register in state.pendingPermissions (for button handler)
      this.state.pendingPermissions.set(requestId, {
        requestId,
        sessionId: session.id,
        resolve: wrappedResolve,
      });

      // Register in session.pendingPermissions (for cleanup on stop)
      session.pendingPermissions.set(requestId, { resolve: wrappedResolve, toolName, input });

      // Send permission buttons to Discord
      this.events.onPermissionRequest?.(session.id, {
        requestId,
        toolName,
        toolInput: input,
      });

      // Timeout: auto-deny after permissionTimeoutMs (0 = no timeout)
      if (this.permissionTimeoutMs > 0) {
        setTimeout(() => {
          if (resolved) return;
          wrappedResolve({ behavior: 'deny', message: 'Permission request timed out' });
          this.events.onPermissionTimeout?.(session.id, requestId, toolName);
        }, this.permissionTimeoutMs);
      }
    });
  }

  private createEntry(id: string, cwd: string, discordThreadId: string): ClaudeSdkSessionEntry {
    const entry: ClaudeSdkSessionEntry = {
      id,
      sdkSessionId: id,
      cwd,
      discordThreadId,
      status: 'idle',
      startedAt: new Date(),
      sessionAbortController: new AbortController(),
      turnAbortController: new AbortController(),
      pendingInputResolve: null,
      inputQueue: [],
      maxQueueLength: this.maxQueueLength,
      pendingPermissions: new Map(),
      activeQuery: null,
      interrupted: false,
      lastAssistantUsage: null,
      transport: {
        type: 'sdk',
        sessionId: id,
        supportsTerminalControls: false,
        supportsModelSwitch: false,
        sendInput: (text) => this.sendInput(id, text),
        interrupt: () => this.interruptSession(id),
        stop: async () => {
          await this.stopSession(id);
        },
        isActive: () => {
          const session = this.sessions.get(id);
          return !!session && session.status !== 'ended';
        },
      },
    };

    return entry;
  }

  private async *createPromptGenerator(session: ClaudeSdkSessionEntry): AsyncGenerator<SDKUserMessage, void> {
    while (session.status !== 'ended') {
      const input = await new Promise<string | EndSentinel>((resolve) => {
        if (session.inputQueue.length > 0) {
          resolve(session.inputQueue.shift()!);
          return;
        }

        session.pendingInputResolve = resolve;
      });

      session.pendingInputResolve = null;

      if (input === END_SENTINEL || (session.status as string) === 'ended') {
        break;
      }

      session.status = 'running';
      await this.events.onSessionStatus?.(session.id, 'running');

      yield {
        type: 'user',
        message: {
          role: 'user',
          content: input,
        },
        parent_tool_use_id: null,
        session_id: session.sdkSessionId,
      };
    }
  }

  private async processQueryStream(
    session: ClaudeSdkSessionEntry,
    options?: { model?: string; resume?: string },
  ): Promise<void> {
    log.info({ sessionId: session.id, sdkSessionId: session.sdkSessionId, threadId: session.discordThreadId, resume: options?.resume, pid: process.pid }, 'processQueryStream: starting');

    // SDK constraint: `sessionId` and `resume` are mutually exclusive
    // (unless `forkSession` is set). When resuming, pass only `resume`.
    // When starting fresh, pass only `sessionId`.
    const sessionOrResume = options?.resume
      ? { resume: options.resume }
      : { sessionId: session.sdkSessionId };

    const queryHandle = query({
      prompt: this.createPromptGenerator(session),
      options: {
        ...sessionOrResume,
        cwd: session.cwd,
        model: options?.model,
        includePartialMessages: false,
        settingSources: ['user', 'project', 'local'],
        canUseTool: async (toolName, input) => {
          return this.handleCanUseTool(session, toolName, input as Record<string, unknown>);
        },
      },
    });

    session.activeQuery = queryHandle;

    const closeQuery = () => {
      queryHandle.close();
    };
    session.sessionAbortController.signal.addEventListener('abort', closeQuery, { once: true });

    let terminatedUnexpectedly = false;

    try {
      for await (const message of queryHandle) {
        // Persist sdkSessionId to channelManager when it changes
        const newSdkSessionId = message.session_id || session.sdkSessionId;
        if (newSdkSessionId !== session.sdkSessionId) {
          session.sdkSessionId = newSdkSessionId;
          await this.events.onSdkSessionIdUpdate?.(session.id, newSdkSessionId);
          log.info({ sessionId: session.id, sdkSessionId: newSdkSessionId }, 'SDK session ID updated');
        } else if (!session.sdkSessionId && message.session_id) {
          session.sdkSessionId = message.session_id;
          await this.events.onSdkSessionIdUpdate?.(session.id, message.session_id);
        }

        await this.handleSdkMessage(session, message);
      }

      log.info({ sessionId: session.id, status: session.status, terminatedUnexpectedly, pid: process.pid }, 'processQueryStream: stream ended');

      terminatedUnexpectedly = session.status !== 'ended';
    } catch (err) {
      log.error({ sessionId: session.id, err, interrupted: session.interrupted, pid: process.pid }, 'processQueryStream: stream error');
      if (session.status !== 'ended') {
        terminatedUnexpectedly = true;
        if (!session.interrupted) {
          throw err;
        }
      }
    } finally {
      log.info({ sessionId: session.id, shuttingDown, interrupted: session.interrupted, terminatedUnexpectedly, pid: process.pid }, 'processQueryStream: finally');
      session.sessionAbortController.signal.removeEventListener('abort', closeQuery);
      session.activeQuery = null;

      if (shuttingDown) {
        // Graceful shutdown — don't archive, don't post errors
        log.info({ sessionId: session.id }, 'SDK session closed during shutdown (persisted mapping kept)');
      } else if (session.interrupted) {
        // Interrupt is intentional — recover to idle, ready for next input
        session.interrupted = false;
        session.turnAbortController = new AbortController();
        session.status = 'idle';
        await this.events.onSessionStatus?.(session.id, 'idle');
        log.info({ sessionId: session.id }, 'SDK session recovered from interrupt');
      } else if (session.status === 'ended') {
        // Normal stop — finalize if stopSession hasn't already
        if (this.sessions.has(session.id)) {
          await this.finalizeSession(session, true);
        }
      } else if (terminatedUnexpectedly) {
        await this.events.onError(session.id, new Error('Claude SDK query ended unexpectedly.'));
        await this.finalizeSession(session, true);
      }
    }
  }

  private async handleSdkMessage(session: ClaudeSdkSessionEntry, message: SDKMessage): Promise<void> {
    switch (message.type) {
      case 'assistant':
        await this.handleAssistantMessage(session, message);
        break;

      case 'tool_use_summary':
        await this.events.onToolResult(session.id, {
          summary: message.summary,
          toolUseIds: message.preceding_tool_use_ids,
        });
        break;

      case 'result':
        await this.completeTurn(session, message);
        if (message.subtype !== 'success' && message.errors.length > 0) {
          await this.events.onError(session.id, new Error(message.errors.join('\n')));
        }
        break;

      default:
        break;
    }
  }

  private async handleAssistantMessage(
    session: ClaudeSdkSessionEntry,
    message: SDKAssistantMessage,
  ): Promise<void> {
    const parts: string[] = [];

    for (const block of message.message.content) {
      if (block.type === 'text' && block.text.trim()) {
        parts.push(block.text);
        continue;
      }

      if (block.type === 'tool_use') {
        await this.events.onToolCall(session.id, {
          toolName: block.name,
          input: block.input,
          toolUseId: block.id,
        });
      }
    }

    const text = parts.join('\n').trim();
    if (text) {
      await this.events.onMessage(session.id, text);
    }

    // Store per-API-call usage from the raw BetaMessage for accurate context % calculation
    const usage = (message.message as any).usage;
    if (usage) {
      session.lastAssistantUsage = usage;
    }
  }

  private async completeTurn(
    session: ClaudeSdkSessionEntry,
    message: SDKResultMessage,
  ): Promise<void> {
    if (session.status === 'ended') {
      return;
    }

    if (session.turnAbortController.signal.aborted) {
      session.turnAbortController = new AbortController();
    }

    session.status = 'idle';
    await this.events.onSessionStatus?.(session.id, 'idle');

    // Use per-API-call usage from the last assistant message (accurate context %)
    // modelUsage is cumulative across the session — not suitable for context window %
    const lastUsage = session.lastAssistantUsage;
    const modelEntries = Object.values(message.modelUsage || {});
    const primary = modelEntries[0];

    if (lastUsage && primary) {
      const contextUsed = (lastUsage.input_tokens || 0)
        + (lastUsage.cache_read_input_tokens || 0)
        + (lastUsage.cache_creation_input_tokens || 0);
      const modelNames = Object.keys(message.modelUsage || {});

      log.info({
        sessionId: session.id,
        model: modelNames[0] || 'unknown',
        perCall: { input: lastUsage.input_tokens, cacheRead: lastUsage.cache_read_input_tokens, cacheCreation: lastUsage.cache_creation_input_tokens, contextUsed },
        contextWindow: primary.contextWindow,
        totalCost: message.total_cost_usd,
        numTurns: message.num_turns,
      }, 'SDK turn usage');

      const modelName = modelNames[0] || 'unknown';
      await this.events.onTurnComplete?.(session.id, {
        model: modelName,
        inputTokens: contextUsed,
        outputTokens: lastUsage.output_tokens || 0,
        cacheReadTokens: lastUsage.cache_read_input_tokens || 0,
        cacheCreationTokens: lastUsage.cache_creation_input_tokens || 0,
        costUSD: primary.costUSD,
        totalCostUSD: message.total_cost_usd,
        contextWindow: primary.contextWindow,
        numTurns: message.num_turns,
      });

      session.lastAssistantUsage = null;
    }
  }

  private async finalizeSession(
    session: ClaudeSdkSessionEntry,
    notifyEnd: boolean,
  ): Promise<void> {
    if (!this.sessions.has(session.id)) {
      return;
    }

    this.sessions.delete(session.id);

    if (notifyEnd) {
      await this.events.onSessionEnd(session.id);
    }
  }
}
