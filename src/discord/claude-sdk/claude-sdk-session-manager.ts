import { randomUUID } from 'crypto';
import {
  query,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKToolUseSummaryMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { discordLogger as log } from '../../utils/logger.js';
import type { ClaudeTransport } from '../claude-transport.js';

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
  transport: ClaudeTransport;
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

export interface ClaudeSdkEvents {
  onSessionStart: (sessionId: string, cwd: string, discordThreadId: string) => void | Promise<void>;
  onSessionEnd: (sessionId: string) => void | Promise<void>;
  onSessionStatus?: (sessionId: string, status: 'running' | 'idle' | 'ended') => void | Promise<void>;
  onMessage: (sessionId: string, content: string) => void | Promise<void>;
  onToolCall: (sessionId: string, info: ClaudeSdkToolCallInfo) => void | Promise<void>;
  onToolResult: (sessionId: string, info: ClaudeSdkToolResultInfo) => void | Promise<void>;
  onError: (sessionId: string, error: Error) => void | Promise<void>;
}

export class ClaudeSdkSessionManager {
  private sessions = new Map<string, ClaudeSdkSessionEntry>();
  private events: ClaudeSdkEvents;
  private maxQueueLength: number;

  constructor(events: ClaudeSdkEvents, options?: { maxQueueLength?: number }) {
    this.events = events;
    this.maxQueueLength = options?.maxQueueLength ?? 10;
  }

  async startSession(
    cwd: string,
    discordThreadId: string,
    options?: { model?: string; sessionId?: string },
  ): Promise<ClaudeSdkSessionEntry> {
    const id = options?.sessionId ?? randomUUID();
    const entry = this.createEntry(id, cwd, discordThreadId);
    this.sessions.set(id, entry);

    await this.events.onSessionStart(id, cwd, discordThreadId);
    this.processQueryStream(entry, options).catch(async (err) => {
      log.error({ sessionId: id, err }, 'Claude SDK session stream failed');
      await this.events.onError(id, err as Error);
      await this.finalizeSession(entry, true);
    });

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
    if (!session || session.status !== 'running') {
      return false;
    }

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

    session.inputQueue.length = 0;
    session.turnAbortController.abort();
    session.sessionAbortController.abort();
    session.activeQuery?.close();

    await this.finalizeSession(session, true);
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

  getAllSessions(): ClaudeSdkSessionEntry[] {
    return Array.from(this.sessions.values());
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

      if (input === END_SENTINEL || session.status === 'ended') {
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
    options?: { model?: string },
  ): Promise<void> {
    const queryHandle = query({
      prompt: this.createPromptGenerator(session),
      options: {
        sessionId: session.id,
        cwd: session.cwd,
        model: options?.model,
        includePartialMessages: false,
        canUseTool: async (_toolName, input) => ({
          behavior: 'allow' as const,
          updatedInput: input,
        }),
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
        session.sdkSessionId = message.session_id || session.sdkSessionId;
        await this.handleSdkMessage(session, message);
      }

      terminatedUnexpectedly = session.status !== 'ended';
    } catch (err) {
      if (session.status !== 'ended') {
        terminatedUnexpectedly = true;
        throw err;
      }
    } finally {
      session.sessionAbortController.signal.removeEventListener('abort', closeQuery);
      session.activeQuery = null;

      if (terminatedUnexpectedly) {
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
  }

  private async completeTurn(
    session: ClaudeSdkSessionEntry,
    _message: SDKResultMessage,
  ): Promise<void> {
    if (session.status === 'ended') {
      return;
    }

    if (session.turnAbortController.signal.aborted) {
      session.turnAbortController = new AbortController();
    }

    session.status = 'idle';
    await this.events.onSessionStatus?.(session.id, 'idle');
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
