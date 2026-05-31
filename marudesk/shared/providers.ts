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
   * as "ready" (secrets.listProviders reports hasKey, and the agent path skips
   * the key requirement). The model list is still fetched live (no key).
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

/* ── model-first catalog (docs/agentic-chat-v2-design.md §5) ─────────────── */

/**
 * How a provider's API speaks — selects the AI SDK factory in
 * electron/agent/model.ts. Built-in providers map 1:1 except Ollama, which is an
 * OpenAI-compatible local endpoint; custom endpoints are always openai-compatible.
 */
export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'openai-compatible';

/**
 * One selectable model, provider-tagged. The UI is **model-first**: the user
 * picks a {@link ModelEntry} from one flat, searchable list and the provider
 * follows. `key` is globally unique (`${provider}:${id}`) so live-fetched and
 * custom-endpoint models can never collide on a bare model id.
 */
export type ModelEntry = {
  key: string;
  id: string;
  label: string;
  provider: ProviderId;
  /** Token context window when known — drives the chat's usage indicator. */
  contextWindow?: number;
  /** Whether the model supports tool calling (the agent requires it). */
  tools?: boolean;
};

/** The globally-unique selection key for a (provider, model id) pair. */
export function modelKey(provider: ProviderId, id: string): string {
  return `${provider}:${id}`;
}

/** Find a model entry by its unique key. */
export function findModel(list: ModelEntry[], key: string): ModelEntry | undefined {
  return list.find((m) => m.key === key);
}

/**
 * The built-in flat model catalog. Each provider's live `/models` list merges
 * over this (electron/models.ts); this seeds the picker before any key is set
 * and backstops a failed fetch. Context windows are filled in only where known.
 */
export const MODELS: ModelEntry[] = [
  // Anthropic (Claude 4.x — 200K context, all tool-capable).
  { key: 'anthropic:claude-opus-4-8', id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', contextWindow: 200_000, tools: true },
  { key: 'anthropic:claude-sonnet-4-6', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: 200_000, tools: true },
  { key: 'anthropic:claude-haiku-4-5-20251001', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200_000, tools: true },
  // OpenAI.
  { key: 'openai:gpt-5', id: 'gpt-5', label: 'GPT-5', provider: 'openai', tools: true },
  { key: 'openai:gpt-5-mini', id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', tools: true },
  { key: 'openai:gpt-4.1', id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai', contextWindow: 1_047_576, tools: true },
  { key: 'openai:o4-mini', id: 'o4-mini', label: 'o4-mini', provider: 'openai', tools: true },
  // Google Gemini (~1M context).
  { key: 'google:gemini-2.5-pro', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google', contextWindow: 1_048_576, tools: true },
  { key: 'google:gemini-2.5-flash', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google', contextWindow: 1_048_576, tools: true },
  // Ollama (local; tool support varies — these two are tool-capable).
  { key: 'ollama:qwen2.5-coder', id: 'qwen2.5-coder', label: 'Qwen2.5 Coder', provider: 'ollama', tools: true },
  { key: 'ollama:llama3.1', id: 'llama3.1', label: 'Llama 3.1', provider: 'ollama', tools: true },
];

export const DEFAULT_MODEL_KEY = modelKey('anthropic', 'claude-sonnet-4-6');

/**
 * A user-configured OpenAI-compatible endpoint (OpenRouter, LM Studio, vLLM,
 * Together, Groq, …). Wired up in the provider-UX phase; the type lives here so
 * the data model is stable. Its API key is stored in secrets under `custom:${id}`.
 */
export type CustomProvider = {
  id: string;
  label: string;
  kind: 'openai-compatible';
  baseUrl: string;
  models: { id: string; label: string; contextWindow?: number; tools?: boolean }[];
};
