export {
  type EmbeddingProvider,
  type EmbeddingSpec,
  type OllamaProviderOptions,
  OllamaEmbeddingProvider,
  EmbeddingService,
} from './embedding-provider.js';

export {
  type MemoryKind,
  type MemoryStatus,
  type MemorySource,
  type MemorySpeaker,
  type MemoryUnit,
  type MemoryRecord,
  type MemorySearchResult,
  type SearchOptions,
  MemoryService,
} from './memory-service.js';

export {
  type ChatMessage,
  type ChatProvider,
  type OllamaChatProviderOptions,
  type ClaudeChatProviderOptions,
  type ClaudeSdkChatProviderOptions,
  OllamaChatProvider,
  ClaudeChatProvider,
  ClaudeSdkChatProvider,
  ChatService,
} from './chat-provider.js';

export {
  type SlidingMessage,
  type DistillInput,
  type DistillResult,
  DistillService,
} from './distill-service.js';

export {
  type CollectorMessage,
  type MemoryCollectorOptions,
  MemoryCollector,
} from './memory-collector.js';

export {
  type ConsolidationOptions,
  type ConsolidationReport,
  type ProjectReport,
  ConsolidationService,
} from './consolidation-service.js';

export {
  type QueuedMessage,
  type BatchResult,
  type BatchResultItem,
  type BatchDistillEvents,
  BatchDistillRunner,
} from './batch-distill-runner.js';

export {
  type MemoryConfig,
  type DistillConfig,
  type ConsolidationConfig,
  type DigestConfig,
  loadMemoryConfig,
  getMemoryConfig,
  saveMemoryConfig,
  updateMemoryConfig,
  ensureConfigFile,
  onConfigChange,
  stopConfigWatcher,
} from './memory-config.js';
