export type ProviderId = 'anthropic' | 'openai' | 'google' | 'ollama';

export type ModelDef = {
  id: string;
  label: string;
};

export type ProviderDef = {
  id: ProviderId;
  label: string;
  /**
   * Static fallback catalog. The live list is fetched per key from each
   * provider's /models endpoint (see electron/models.ts); these seed the picker
   * before a key is set and backstop a failed fetch.
   */
  models: ModelDef[];
  defaultModelId: string;
  apiKeyPlaceholder: string;
  apiKeyHint: string;
  /**
   * A local/keyless provider (Ollama): needs no API key, so it is always treated
   * as "ready" (secrets.listProviders reports hasKey, and the propose/agent paths
   * skip the key requirement). The model list is still fetched live (no key).
   */
  keyless?: boolean;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
    defaultModelId: 'claude-sonnet-4-6',
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyHint: 'console.anthropic.com → API Keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'o4-mini', label: 'o4-mini' },
    ],
    defaultModelId: 'gpt-5',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHint: 'platform.openai.com → API keys',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    defaultModelId: 'gemini-2.5-pro',
    apiKeyPlaceholder: 'AIza...',
    apiKeyHint: 'aistudio.google.com → Get API key',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    keyless: true,
    // Common local coding models; the live list is fetched from /api/tags.
    models: [
      { id: 'qwen2.5-coder', label: 'Qwen2.5 Coder' },
      { id: 'llama3.1', label: 'Llama 3.1' },
    ],
    defaultModelId: 'qwen2.5-coder',
    apiKeyPlaceholder: '(local — no key)',
    apiKeyHint: 'Runs locally at localhost:11434 (no key). Use a tool-capable model.',
  },
];

export function getProvider(id: ProviderId): ProviderDef {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    PROVIDERS.some((p) => p.id === (value as ProviderId))
  );
}

export type ProviderStatus = {
  id: ProviderId;
  hasKey: boolean;
};
