export interface ProviderConfig {
  id: string;
  baseURL: string;
  apiKeyEnv: string;
}

export interface ModelDefinition {
  alias: string;
  apiId: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  pricing: { inputPerMTok: number; outputPerMTok: number };
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  openrouter: {
    id: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  deepinfra: {
    id: 'deepinfra',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
  },
};

export const MODEL_REGISTRY: ModelDefinition[] = [
  {
    alias: 'gemma4',
    apiId: 'google/gemma-4-27b-it',
    displayName: 'Gemma 4',
    provider: 'openrouter',
    contextWindow: 131_072,
    pricing: { inputPerMTok: 0.08, outputPerMTok: 0.35 },
  },
  {
    alias: 'glm5',
    apiId: 'z-ai/glm-5',
    displayName: 'GLM-5',
    provider: 'openrouter',
    contextWindow: 131_072,
    pricing: { inputPerMTok: 0.72, outputPerMTok: 2.30 },
  },
  {
    alias: 'glm51',
    apiId: 'z-ai/glm-5.1',
    displayName: 'GLM-5.1',
    provider: 'openrouter',
    contextWindow: 131_072,
    pricing: { inputPerMTok: 0.95, outputPerMTok: 3.15 },
  },
  {
    alias: 'qwen3-coder',
    apiId: 'qwen/qwen3-coder',
    displayName: 'Qwen3 Coder',
    provider: 'openrouter',
    contextWindow: 262_144,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },  // free tier
  },
];

export function getModelByAlias(alias: string): ModelDefinition | undefined {
  return MODEL_REGISTRY.find(m => m.alias === alias);
}

export function getAllAliases(): string[] {
  return MODEL_REGISTRY.map(m => m.alias);
}

export function getProviderConfig(providerId: string): ProviderConfig | undefined {
  return PROVIDERS[providerId];
}
