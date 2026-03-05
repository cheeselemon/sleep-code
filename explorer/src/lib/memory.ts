import 'server-only';
import { OllamaEmbeddingProvider, EmbeddingService, MemoryService } from '../../../src/memory/index.js';

let _service: MemoryService | null = null;
let _initPromise: Promise<MemoryService> | null = null;

export async function getMemoryService(): Promise<MemoryService> {
  if (_service) return _service;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const provider = new OllamaEmbeddingProvider();
    const embedding = new EmbeddingService(provider);
    await embedding.initialize();
    const memory = new MemoryService(embedding);
    await memory.initialize();
    _service = memory;
    return memory;
  })();

  return _initPromise;
}
