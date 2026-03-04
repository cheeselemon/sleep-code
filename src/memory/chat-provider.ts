import { spawn } from 'child_process';
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

// ── Chat Service ─────────────────────────────────────────────

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
