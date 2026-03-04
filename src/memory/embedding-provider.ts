import { logger } from '../utils/logger.js';

const log = logger.child({ component: 'memory' });

// ── Interface ────────────────────────────────────────────────

export interface EmbeddingProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly dimension: number;

  healthCheck(): Promise<void>;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingSpec {
  providerId: string;
  modelId: string;
  dimension: number;
}

// ── Ollama Provider ──────────────────────────────────────────

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
}

const OLLAMA_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3-embedding:4b',
  dimension: 2560,
} as const;

const MODEL_DIMENSIONS: Record<string, number> = {
  'qwen3-embedding:0.6b': 1024,
  'qwen3-embedding:4b': 2560,
  'qwen3-embedding:8b': 4096,
  'bge-m3': 1024,
  'nomic-embed-text': 768,
  'embeddinggemma': 768,
  'all-minilm': 384,
};

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = 'ollama';
  readonly modelId: string;
  readonly dimension: number;
  private readonly baseUrl: string;

  constructor(options?: OllamaProviderOptions) {
    this.baseUrl = options?.baseUrl ?? OLLAMA_DEFAULTS.baseUrl;
    this.modelId = options?.model ?? OLLAMA_DEFAULTS.model;
    this.dimension = MODEL_DIMENSIONS[this.modelId] ?? OLLAMA_DEFAULTS.dimension;
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
    log.info({ model: this.modelId }, 'Ollama embedding provider healthy');
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.modelId, input: text }),
      });
      if (!res.ok) {
        throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as { embeddings: number[][] };
      results.push(data.embeddings[0]);
    }
    return results;
  }
}

// ── Embedding Service ────────────────────────────────────────

export class EmbeddingService {
  private provider: EmbeddingProvider;

  constructor(provider: EmbeddingProvider) {
    this.provider = provider;
  }

  async initialize(): Promise<void> {
    await this.provider.healthCheck();
  }

  getSpec(): EmbeddingSpec {
    return {
      providerId: this.provider.providerId,
      modelId: this.provider.modelId,
      dimension: this.provider.dimension,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.provider.embed(texts);
  }

  async embedSingle(text: string): Promise<number[]> {
    const [vector] = await this.provider.embed([text]);
    return vector;
  }
}
