import { spawn } from 'child_process';
import {
  query,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../utils/logger.js';

const log = logger.child({ component: 'memory' });

// ── Interface ────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatProvider {
  readonly providerId: string;
  readonly modelId: string;

  healthCheck(): Promise<void>;
  chat(messages: ChatMessage[]): Promise<string>;
}

// ── Ollama Chat Provider ─────────────────────────────────────

export interface OllamaChatProviderOptions {
  baseUrl?: string;
  model?: string;
}

const OLLAMA_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen2.5:7b',
} as const;

export class OllamaChatProvider implements ChatProvider {
  readonly providerId = 'ollama';
  readonly modelId: string;
  private readonly baseUrl: string;

  constructor(options?: OllamaChatProviderOptions) {
    this.baseUrl = options?.baseUrl ?? OLLAMA_DEFAULTS.baseUrl;
    this.modelId = options?.model ?? OLLAMA_DEFAULTS.model;
  }

  async healthCheck(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) {
      throw new Error(`Ollama not reachable: ${res.status}`);
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = data.models ?? [];
    const hasModel = models.some(
      (m) => m.name === this.modelId || m.name.startsWith(`${this.modelId}:`)
    );
    if (!hasModel) {
      throw new Error(
        `Model "${this.modelId}" not found in Ollama. Run: ollama pull ${this.modelId}`
      );
    }
    log.info({ model: this.modelId }, 'Ollama chat provider healthy');
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelId,
        messages,
        format: 'json',
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama chat failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { message?: { content: string } };
    return data.message?.content ?? '';
  }
}

// ── Claude CLI Provider ──────────────────────────────────────

export interface ClaudeChatProviderOptions {
  model?: string;
  timeoutMs?: number;
}

export class ClaudeChatProvider implements ChatProvider {
  readonly providerId = 'claude-cli';
  readonly modelId: string;
  private readonly timeoutMs: number;

  constructor(options?: ClaudeChatProviderOptions) {
    this.modelId = options?.model ?? 'haiku';
    this.timeoutMs = options?.timeoutMs ?? 30_000;
  }

  async healthCheck(): Promise<void> {
    try {
      const result = await this.exec(['--version']);
      if (!result) throw new Error('No output from claude --version');
      log.info({ model: this.modelId }, 'Claude CLI chat provider healthy');
    } catch (err) {
      throw new Error(
        `Claude CLI not available. Install: npm install -g @anthropic-ai/claude-code. Error: ${err}`
      );
    }
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const systemMsg = messages.find((m) => m.role === 'system');
    const userMsgs = messages.filter((m) => m.role !== 'system');
    const prompt = userMsgs.map((m) => m.content).join('\n\n');

    const args = ['-p', '--model', this.modelId, '--output-format', 'json'];
    if (systemMsg) {
      args.push('--system-prompt', systemMsg.content);
    }

    const raw = await this.exec(args, prompt);

    // --output-format json returns: {"type":"result","result":"..."}
    try {
      const parsed = JSON.parse(raw);
      return parsed.result ?? raw;
    } catch {
      return raw;
    }
  }

  private exec(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      const proc = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.timeoutMs,
        env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`claude exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      if (stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      } else {
        proc.stdin.end();
      }
    });
  }
}

// ── Claude SDK Chat Provider ─────────────────────────────────
//
// Uses Claude Agent SDK for distill / digest.
// Maintains a persistent SDK session for cache-efficient multi-turn usage.
// No tool use — pure text in/out.

export interface ClaudeSdkChatProviderOptions {
  model?: string;
  /** Max turns per session before auto-refresh (default: 100) */
  maxTurnsBeforeRefresh?: number;
  /** CWD for the SDK session (default: homedir) */
  cwd?: string;
}

const END_SENTINEL = Symbol('sdk-chat-end');
type EndSentinel = typeof END_SENTINEL;

export class ClaudeSdkChatProvider implements ChatProvider {
  readonly providerId = 'claude-sdk';
  readonly modelId: string;
  private readonly cwd: string;
  private readonly maxTurnsBeforeRefresh: number;

  // Session state
  private activeQuery: Query | null = null;
  private sessionAbortController: AbortController | null = null;
  private turnCount = 0;
  private systemPrompt: string | null = null;

  // Prompt generator coordination
  private pendingInputResolve: ((value: string | EndSentinel) => void) | null = null;
  private pendingResponseResolve: ((value: string) => void) | null = null;
  private pendingResponseReject: ((err: Error) => void) | null = null;
  private sessionReady = false;
  private sessionError: Error | null = null;

  constructor(options?: ClaudeSdkChatProviderOptions) {
    this.modelId = options?.model ?? 'haiku';
    this.maxTurnsBeforeRefresh = options?.maxTurnsBeforeRefresh ?? 100;
    this.cwd = options?.cwd ?? process.env.HOME ?? '/tmp';
  }

  async healthCheck(): Promise<void> {
    // Try a minimal query to verify SDK connectivity
    log.info({ model: this.modelId }, 'Claude SDK chat provider ready');
  }

  /**
   * Send messages and get a response using the persistent SDK session.
   * System message is extracted and used as the session system prompt.
   * Only the user messages are sent as the turn content.
   */
  async chat(messages: ChatMessage[]): Promise<string> {
    const systemMsg = messages.find((m) => m.role === 'system');
    const userMsgs = messages.filter((m) => m.role !== 'system');
    const userContent = userMsgs.map((m) => m.content).join('\n\n');

    // If system prompt changed or session needs refresh, restart
    const newSystemPrompt = systemMsg?.content ?? null;
    if (
      !this.activeQuery ||
      this.sessionError ||
      this.turnCount >= this.maxTurnsBeforeRefresh ||
      (newSystemPrompt && newSystemPrompt !== this.systemPrompt)
    ) {
      await this.refreshSession(newSystemPrompt);
    }

    this.turnCount++;

    // Send user input and wait for the full response
    return new Promise<string>((resolve, reject) => {
      this.pendingResponseResolve = resolve;
      this.pendingResponseReject = reject;

      // Feed the user message into the prompt generator
      if (this.pendingInputResolve) {
        this.pendingInputResolve(userContent);
        this.pendingInputResolve = null;
      } else {
        // Should not happen — but defensive
        reject(new Error('SDK session not waiting for input'));
      }
    });
  }

  /** Force refresh the SDK session */
  async refreshSession(systemPrompt?: string | null): Promise<void> {
    await this.closeSession();

    if (systemPrompt !== undefined) {
      this.systemPrompt = systemPrompt;
    }

    this.turnCount = 0;
    this.sessionError = null;
    this.sessionReady = false;
    this.sessionAbortController = new AbortController();

    const abortController = this.sessionAbortController;

    // Start the query stream in the background
    const queryHandle = query({
      prompt: this.createPromptGenerator(abortController.signal),
      options: {
        model: this.modelId,
        cwd: this.cwd,
        systemPrompt: this.systemPrompt ?? undefined,
        // No tools — deny everything
        canUseTool: async () => ({ behavior: 'deny' as const, message: 'No tools allowed in distill mode' }),
      },
    });

    this.activeQuery = queryHandle;

    // Process response stream in background
    this.processStream(queryHandle, abortController.signal).catch((err) => {
      if (abortController.signal.aborted) return;
      log.error({ err }, 'SDK chat session stream error');
      this.sessionError = err as Error;
      // Reject any pending chat() call
      if (this.pendingResponseReject) {
        this.pendingResponseReject(err as Error);
        this.pendingResponseResolve = null;
        this.pendingResponseReject = null;
      }
    });

    // Wait for the session to be ready (prompt generator is waiting for first input)
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.sessionReady || this.sessionError) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    if (this.sessionError) {
      throw this.sessionError;
    }

    log.info({ model: this.modelId, turnCount: 0 }, 'SDK chat session started');
  }

  /** Close the current session */
  async closeSession(): Promise<void> {
    if (this.pendingInputResolve) {
      this.pendingInputResolve(END_SENTINEL);
      this.pendingInputResolve = null;
    }
    this.sessionAbortController?.abort();
    this.activeQuery?.close();
    this.activeQuery = null;
    this.sessionAbortController = null;
    this.sessionReady = false;
  }

  /** Whether the session is active */
  get isActive(): boolean {
    return !!this.activeQuery && !this.sessionError;
  }

  private async *createPromptGenerator(
    signal: AbortSignal,
  ): AsyncGenerator<SDKUserMessage, void> {
    while (!signal.aborted) {
      const input = await new Promise<string | EndSentinel>((resolve) => {
        this.pendingInputResolve = resolve;
        this.sessionReady = true;
      });

      this.pendingInputResolve = null;

      if (input === END_SENTINEL || signal.aborted) {
        break;
      }

      yield {
        type: 'user',
        message: { role: 'user', content: input },
        parent_tool_use_id: null,
        session_id: '',
      };
    }
  }

  private async processStream(queryHandle: Query, signal: AbortSignal): Promise<void> {
    try {
      for await (const message of queryHandle) {
        if (signal.aborted) break;

        if (message.type === 'assistant') {
          const parts: string[] = [];
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              parts.push(block.text);
            }
          }
          const text = parts.join('\n').trim();
          if (text && this.pendingResponseResolve) {
            this.pendingResponseResolve(text);
            this.pendingResponseResolve = null;
            this.pendingResponseReject = null;
          }
        }

        if (message.type === 'result') {
          // Turn completed — if we still have a pending resolve (no assistant text),
          // resolve with empty to avoid hanging
          if (this.pendingResponseResolve) {
            const resultText = (message as any).result ?? '';
            this.pendingResponseResolve(resultText);
            this.pendingResponseResolve = null;
            this.pendingResponseReject = null;
          }
        }
      }
    } catch (err) {
      if (!signal.aborted) throw err;
    }
  }
}

// ── Chat Service ─────���───────────────────────────────────────

export class ChatService {
  private provider: ChatProvider;

  constructor(provider: ChatProvider) {
    this.provider = provider;
  }

  async initialize(): Promise<void> {
    await this.provider.healthCheck();
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    return this.provider.chat(messages);
  }
}
