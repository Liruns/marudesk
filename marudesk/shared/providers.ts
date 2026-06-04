/**
 * The built-in, first-party providers. `openai-codex` and `google-caa` are
 * OAuth-only "use your subscription" providers that target a different backend
 * than their API-key siblings (`openai`/`google`): OpenAI's ChatGPT Codex
 * (`backend-api/codex`, Responses dialect) and Google's Code-Assist
 * (`cloudcode-pa…/v1internal`). They're separate ids — not auth modes of
 * `openai`/`google` — because the API, models, and request shape all differ.
 */
export type BuiltinProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'ollama'
  | 'xai'
  | 'openai-codex'
  | 'google-caa'
  | 'zai'
  | 'opencode';

/**
 * A provider id: either a built-in, or a user-configured custom OpenAI-compatible
 * endpoint tagged `custom:<id>` (OpenRouter / LM Studio / vLLM / Together / …).
 * The template-literal member is why `Record<ProviderId, …>` maps are keyed over
 * {@link BuiltinProviderId} instead (DRIVERS, the provider-store maps); the
 * encrypted creds file uses `Partial<Record<ProviderId, …>>`, which tolerates it.
 */
export type ProviderId = BuiltinProviderId | `custom:${string}`;

export type ModelDef = {
  id: string;
  label: string;
};

export type ImageGenerationTransport =
  | 'openai-images'
  | 'openai-compatible-images';

export type VideoGenerationTransport =
  | 'openai-videos'
  | 'openai-compatible-videos'
  | 'xai-videos';

export type ProviderDef = {
  id: BuiltinProviderId;
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
  /**
   * Whether this provider can be connected via OAuth subscription login (use a
   * Claude Pro/Max account instead of a metered API key) — see
   * docs/oauth-providers-design.md. The agent prefers an OAuth connection over a
   * stored API key when both exist.
   */
  oauth?: boolean;
  /**
   * OAuth is the ONLY way to use this provider — there's no API-key path (the
   * subscription backends `openai-codex` / `google-caa`). Settings shows just the
   * "Connect" section (no key editor), and the agent requires an OAuth connection.
   */
  oauthOnly?: boolean;
  /**
   * An experimental provider whose backend is undocumented/unverified (the
   * subscription `openai-codex` / `google-caa` paths). The model picker groups
   * these last under an "Experimental" heading and tags them so they don't crowd
   * the stable providers — see docs/agentic-chat-v4-design.md §A1.
   */
  experimental?: boolean;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    oauth: true,
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
      { id: 'gpt-image-2', label: 'GPT Image 2' },
      { id: 'sora-2', label: 'Sora 2' },
      { id: 'sora-2-pro', label: 'Sora 2 Pro' },
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
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
    ],
    defaultModelId: 'gemini-2.5-pro',
    apiKeyPlaceholder: 'AIza...',
    apiKeyHint: 'aistudio.google.com → Get API key',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    oauth: true,
    // NB: grok-2/grok-3/grok-4* and grok-code-fast-1 were RETIRED 2026-05-15
    // (requests now redirect to grok-4.3 and bill at its rate) — do not list
    // them. Current chat models per docs.x.ai / models.dev: grok-4.3 (default
    // workhorse) and grok-build-0.1 (coding-specialized). The live /models fetch
    // (electron/models.ts) refreshes this list once an API key is set.
    models: [
      { id: 'grok-4.3', label: 'Grok 4.3' },
      { id: 'grok-build-0.1', label: 'Grok Build (coding)' },
      { id: 'grok-imagine-image-quality', label: 'Grok Imagine Image Quality' },
      { id: 'grok-imagine-video', label: 'Grok Imagine Video' },
    ],
    defaultModelId: 'grok-4.3',
    apiKeyPlaceholder: 'xai-...',
    apiKeyHint: 'console.x.ai → API Keys, or "Connect with Grok" to use your account',
  },
  {
    id: 'openai-codex',
    label: 'OpenAI (ChatGPT)',
    oauth: true,
    oauthOnly: true,
    experimental: true,
    // Codex backend models (Responses dialect) — chatgpt.com/backend-api/codex.
    // The bare `gpt-5` slug is rejected on a ChatGPT account ("not supported when
    // using Codex with a ChatGPT account") — use a `-codex`/versioned slug. The
    // accepted set tracks the Codex CLI and is NOT the API-key set; as of
    // 2026-06 it includes gpt-5-codex, gpt-5.3-codex, and gpt-5.5 (default for
    // ChatGPT-auth sessions). ⚠ Unverified against a live account — confirm by
    // dogfood; see docs/agentic-chat-v4-design.md §A3.
    models: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ],
    defaultModelId: 'gpt-5-codex',
    apiKeyPlaceholder: '(OAuth only)',
    apiKeyHint: 'Sign in with your ChatGPT (Plus/Pro) account — no API key.',
  },
  {
    id: 'google-caa',
    label: 'Google (Gemini account)',
    oauth: true,
    oauthOnly: true,
    experimental: true,
    // Served via the Code-Assist backend (cloudcode-pa) on a personal Google
    // account. Accepts the GA Code Assist models gemini-2.5-pro / -flash.
    // ⚠ Gemini Code Assist for individual/consumer accounts is scheduled to stop
    // serving on 2026-06-18 (migration to Antigravity CLI) — this provider may
    // stop working after that date. Unverified against a live account; dogfood.
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (account)' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (account)' },
    ],
    defaultModelId: 'gemini-2.5-pro',
    apiKeyPlaceholder: '(OAuth only)',
    apiKeyHint: 'Sign in with your Google account — no API key.',
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
  {
    id: 'zai',
    label: 'Z.ai (GLM)',
    // Zhipu's GLM family via the OpenAI-compatible API at api.z.ai/api/paas/v4
    // (Bearer auth). The live list is fetched once a key is set; these seed it.
    // A GLM Coding Plan key instead targets api.z.ai/api/coding/paas/v4 — add it
    // as a custom endpoint if you have a Coding-Plan-scoped key.
    models: [
      { id: 'glm-4.6', label: 'GLM-4.6' },
      { id: 'glm-4.5', label: 'GLM-4.5' },
      { id: 'glm-4.5-air', label: 'GLM-4.5 Air' },
    ],
    defaultModelId: 'glm-4.6',
    apiKeyPlaceholder: '••••••••',
    apiKeyHint: 'z.ai → API keys (ZHIPU_API_KEY)',
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    // OpenCode's curated gateway (opencode.ai/zen/v1) re-exposes GPT/Claude/Gemini/
    // Grok/Qwen/GLM/Kimi behind one OpenAI-compatible endpoint (Bearer auth). Model
    // ids are passed bare; the live /models fetch refreshes this seed once a key is set.
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'grok-code', label: 'Grok Code Fast 1' },
    ],
    defaultModelId: 'gpt-5.5',
    apiKeyPlaceholder: '••••••••',
    apiKeyHint: 'opencode.ai/zen → API keys (OPENCODE_API_KEY)',
  },
];

export function getProvider(id: ProviderId): ProviderDef {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

export function isBuiltinProviderId(value: unknown): value is BuiltinProviderId {
  return (
    typeof value === 'string' &&
    PROVIDERS.some((p) => p.id === (value as BuiltinProviderId))
  );
}

/** A custom endpoint id is `custom:<non-empty local id>`. */
export function isCustomProviderId(value: unknown): value is `custom:${string}` {
  return (
    typeof value === 'string' &&
    value.startsWith('custom:') &&
    value.length > 'custom:'.length
  );
}

export function isProviderId(value: unknown): value is ProviderId {
  return isBuiltinProviderId(value) || isCustomProviderId(value);
}

/** Build the `custom:<id>` provider id for a custom endpoint's local id. */
export function customProviderId(id: string): `custom:${string}` {
  return `custom:${id}`;
}

/** Extract the local id from a `custom:<id>` provider id, or null when built-in. */
export function parseCustomProviderId(provider: ProviderId): string | null {
  return provider.startsWith('custom:')
    ? provider.slice('custom:'.length)
    : null;
}

export type ProviderStatus = {
  id: ProviderId;
  /** A usable API key is stored (or the provider is keyless). */
  hasKey: boolean;
  /**
   * An OAuth subscription connection is stored (Claude Pro/Max login). When set,
   * the agent prefers it over `hasKey`. Only meaningful for providers with
   * {@link ProviderDef.oauth}; absent/false otherwise — see
   * docs/oauth-providers-design.md.
   */
  oauth?: boolean;
};

/**
 * OAuth subscription tokens stored (encrypted) alongside a provider's optional
 * API key — see docs/oauth-providers-design.md §3/§5. `expiresAt` is epoch ms;
 * the main process refreshes proactively with a small skew before it. Never
 * crosses to the renderer — only the boolean {@link ProviderStatus.oauth} does.
 */
export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which `accessToken` expires. */
  expiresAt: number;
  /** Space-separated granted scopes, when the token endpoint returns them. */
  scope?: string;
};

/**
 * How a provider's OAuth callback is captured — docs/oauth-providers-design.md.
 * `manual-paste`: a hosted callback page shows a `code#state` the user pastes back
 * (Anthropic). `loopback`: a transient `127.0.0.1` server auto-captures the
 * redirect (xAI / the OIDC-style providers). The renderer branches its connect UI
 * on this; the value comes back from `auth:oauth-start`.
 */
export type OAuthFlow = 'manual-paste' | 'loopback';

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
  /** Supports image input — drives the picker's capability badge. */
  vision?: boolean;
  /** A reasoning/extended-thinking model — drives the picker's capability badge. */
  reasoning?: boolean;
  /** Can create images from text prompts. Distinct from `vision` image input. */
  imageGeneration?: boolean;
  /** Can edit or transform a source image. */
  imageEdit?: boolean;
  /** API dialect to use for image generation/edit calls. */
  imageTransport?: ImageGenerationTransport;
  /** Can create videos from text prompts or supported references. */
  videoGeneration?: boolean;
  /** Can edit or extend a source video. */
  videoEdit?: boolean;
  /** API dialect to use for video generation/edit calls. */
  videoTransport?: VideoGenerationTransport;
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
  // Anthropic (Claude 4.x — all tool-capable; vision + extended thinking).
  // Opus/Sonnet 4.6+ carry a 1M-token context; Haiku 4.5 is 200K.
  { key: 'anthropic:claude-opus-4-8', id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'anthropic:claude-sonnet-4-6', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'anthropic:claude-haiku-4-5-20251001', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200_000, tools: true, vision: true, reasoning: true },
  // OpenAI (GPT-5 family = 400K context; gpt-4.1 the prior 1M-context gen).
  { key: 'openai:gpt-5', id: 'gpt-5', label: 'GPT-5', provider: 'openai', contextWindow: 400_000, tools: true, vision: true, reasoning: true },
  { key: 'openai:gpt-5-mini', id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', contextWindow: 400_000, tools: true, vision: true, reasoning: true },
  { key: 'openai:gpt-4.1', id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai', contextWindow: 1_047_576, tools: true, vision: true },
  { key: 'openai:o4-mini', id: 'o4-mini', label: 'o4-mini', provider: 'openai', contextWindow: 200_000, tools: true, reasoning: true },
  { key: 'openai:gpt-image-2', id: 'gpt-image-2', label: 'GPT Image 2', provider: 'openai', tools: false, vision: true, imageGeneration: true, imageEdit: true, imageTransport: 'openai-images' },
  { key: 'openai:sora-2', id: 'sora-2', label: 'Sora 2', provider: 'openai', tools: false, vision: true, videoGeneration: true, videoEdit: true, videoTransport: 'openai-videos' },
  { key: 'openai:sora-2-pro', id: 'sora-2-pro', label: 'Sora 2 Pro', provider: 'openai', tools: false, vision: true, videoGeneration: true, videoEdit: true, videoTransport: 'openai-videos' },
  // Google Gemini (~1M context).
  { key: 'google:gemini-2.5-pro', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  { key: 'google:gemini-2.5-flash', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  { key: 'google:gemini-2.5-flash-lite', id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', provider: 'google', contextWindow: 1_048_576, tools: true, vision: true },
  // xAI Grok (OpenAI-compatible API at api.x.ai/v1; tool-capable). grok-2/3/4*
  // and grok-code-fast-1 were retired 2026-05-15 — current models only.
  { key: 'xai:grok-4.3', id: 'grok-4.3', label: 'Grok 4.3', provider: 'xai', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'xai:grok-build-0.1', id: 'grok-build-0.1', label: 'Grok Build (coding)', provider: 'xai', contextWindow: 256_000, tools: true },
  { key: 'xai:grok-imagine-image-quality', id: 'grok-imagine-image-quality', label: 'Grok Imagine Image Quality', provider: 'xai', tools: false, vision: true, imageGeneration: true, imageEdit: true, imageTransport: 'openai-compatible-images' },
  { key: 'xai:grok-imagine-video', id: 'grok-imagine-video', label: 'Grok Imagine Video', provider: 'xai', tools: false, vision: true, videoGeneration: true, videoEdit: true, videoTransport: 'xai-videos' },
  // OpenAI ChatGPT (Codex backend, OAuth-only — Responses dialect). Experimental.
  // The bare `gpt-5` slug 400s ("not supported when using Codex with a ChatGPT
  // account"); use a codex/versioned slug. Accepted set tracks the Codex CLI (≠
  // the API-key set) and is unverified against a live account — confirm by dogfood.
  { key: 'openai-codex:gpt-5-codex', id: 'gpt-5-codex', label: 'GPT-5 Codex', provider: 'openai-codex', tools: true, reasoning: true },
  { key: 'openai-codex:gpt-5.3-codex', id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'openai-codex', tools: true, reasoning: true },
  { key: 'openai-codex:gpt-5.5', id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai-codex', tools: true, reasoning: true },
  // Google Gemini via a personal account (Code-Assist backend, OAuth-only). Experimental.
  { key: 'google-caa:gemini-2.5-pro', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (account)', provider: 'google-caa', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  { key: 'google-caa:gemini-2.5-flash', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (account)', provider: 'google-caa', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  // Ollama (local; tool support varies — these two are tool-capable).
  { key: 'ollama:qwen2.5-coder', id: 'qwen2.5-coder', label: 'Qwen2.5 Coder', provider: 'ollama', tools: true },
  { key: 'ollama:llama3.1', id: 'llama3.1', label: 'Llama 3.1', provider: 'ollama', tools: true },
  // Z.ai GLM (OpenAI-compatible at api.z.ai/api/paas/v4; tool-capable + reasoning).
  { key: 'zai:glm-4.6', id: 'glm-4.6', label: 'GLM-4.6', provider: 'zai', contextWindow: 204_800, tools: true, reasoning: true },
  { key: 'zai:glm-4.5', id: 'glm-4.5', label: 'GLM-4.5', provider: 'zai', contextWindow: 131_072, tools: true, reasoning: true },
  { key: 'zai:glm-4.5-air', id: 'glm-4.5-air', label: 'GLM-4.5 Air', provider: 'zai', contextWindow: 131_072, tools: true, reasoning: true },
  // OpenCode Zen gateway (opencode.ai/zen/v1) — curated multi-vendor catalog.
  { key: 'opencode:gpt-5.5', id: 'gpt-5.5', label: 'GPT-5.5', provider: 'opencode', contextWindow: 400_000, tools: true, reasoning: true },
  { key: 'opencode:claude-sonnet-4-6', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'opencode', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'opencode:grok-code', id: 'grok-code', label: 'Grok Code Fast 1', provider: 'opencode', contextWindow: 256_000, tools: true },
];

export const DEFAULT_MODEL_KEY = modelKey('anthropic', 'claude-sonnet-4-6');

type ImageGenerationCapability = {
  imageGeneration?: boolean;
  imageEdit?: boolean;
  imageTransport?: ImageGenerationTransport;
};

type VideoGenerationCapability = {
  videoGeneration?: boolean;
  videoEdit?: boolean;
  videoTransport?: VideoGenerationTransport;
};

export function inferImageGenerationCapability(
  provider: ProviderId,
  modelId: string,
): ImageGenerationCapability {
  const id = modelId.toLowerCase();
  if (provider === 'openai' && (/^gpt-image-/.test(id) || /^dall-e-/.test(id))) {
    return {
      imageGeneration: true,
      imageEdit: /^gpt-image-/.test(id) || id === 'dall-e-2',
      imageTransport: 'openai-images',
    };
  }
  if ((provider === 'xai' || isCustomProviderId(provider)) && /^grok-imagine-image/.test(id)) {
    return {
      imageGeneration: true,
      imageEdit: true,
      imageTransport: 'openai-compatible-images',
    };
  }
  if (isCustomProviderId(provider) && (/^gpt-image-/.test(id) || /^dall-e-/.test(id))) {
    return {
      imageGeneration: true,
      imageEdit: /^gpt-image-/.test(id) || id === 'dall-e-2',
      imageTransport: 'openai-compatible-images',
    };
  }
  return {};
}

export function inferVideoGenerationCapability(
  provider: ProviderId,
  modelId: string,
): VideoGenerationCapability {
  const id = modelId.toLowerCase();
  if (provider === 'openai' && /^sora-2/.test(id)) {
    return {
      videoGeneration: true,
      videoEdit: true,
      videoTransport: 'openai-videos',
    };
  }
  if ((provider === 'xai' || isCustomProviderId(provider)) && /^grok-imagine-video/.test(id)) {
    return {
      videoGeneration: true,
      videoEdit: true,
      videoTransport: 'xai-videos',
    };
  }
  if (isCustomProviderId(provider) && /^sora-2/.test(id)) {
    return {
      videoGeneration: true,
      videoEdit: true,
      videoTransport: 'openai-compatible-videos',
    };
  }
  return {};
}

export function mergeInferredModelCapabilities(entry: ModelEntry): ModelEntry {
  const inferred = inferImageGenerationCapability(entry.provider, entry.id);
  const inferredVideo = inferVideoGenerationCapability(entry.provider, entry.id);
  const imageGeneration = entry.imageGeneration ?? inferred.imageGeneration;
  const videoGeneration = entry.videoGeneration ?? inferredVideo.videoGeneration;
  return {
    ...entry,
    tools: entry.tools ?? (imageGeneration || videoGeneration ? false : true),
    imageGeneration,
    imageEdit: entry.imageEdit ?? inferred.imageEdit,
    imageTransport: entry.imageTransport ?? inferred.imageTransport,
    videoGeneration,
    videoEdit: entry.videoEdit ?? inferredVideo.videoEdit,
    videoTransport: entry.videoTransport ?? inferredVideo.videoTransport,
  };
}

function imageCapable(model: ModelEntry): boolean {
  const entry = mergeInferredModelCapabilities(model);
  return entry.imageGeneration === true && !!entry.imageTransport;
}

function videoCapable(model: ModelEntry): boolean {
  const entry = mergeInferredModelCapabilities(model);
  return entry.videoGeneration === true && !!entry.videoTransport;
}

function pushUniqueMedia(
  target: ModelEntry[],
  seen: Set<string>,
  candidate: ModelEntry | undefined,
  capable: (model: ModelEntry) => boolean,
): void {
  if (!candidate || seen.has(candidate.key) || !capable(candidate)) return;
  seen.add(candidate.key);
  target.push(mergeInferredModelCapabilities(candidate));
}

function rankGenerationModels(input: {
  models: readonly ModelEntry[];
  selectedModelKey?: string;
  preferredProvider?: ProviderId;
  capable: (model: ModelEntry) => boolean;
}): ModelEntry[] {
  const all = input.models.map(mergeInferredModelCapabilities);
  const selected = input.selectedModelKey ? findModel(all, input.selectedModelKey) : undefined;
  const provider = input.preferredProvider ?? selected?.provider;
  const ranked: ModelEntry[] = [];
  const seen = new Set<string>();
  pushUniqueMedia(ranked, seen, selected, input.capable);
  if (provider) {
    for (const model of all.filter((m) => m.provider === provider)) {
      pushUniqueMedia(ranked, seen, model, input.capable);
    }
  }
  for (const model of all) pushUniqueMedia(ranked, seen, model, input.capable);
  return ranked;
}

export function rankImageGenerationModels(input: {
  models: readonly ModelEntry[];
  selectedModelKey?: string;
  preferredProvider?: ProviderId;
}): ModelEntry[] {
  return rankGenerationModels({ ...input, capable: imageCapable });
}

export function rankVideoGenerationModels(input: {
  models: readonly ModelEntry[];
  selectedModelKey?: string;
  preferredProvider?: ProviderId;
}): ModelEntry[] {
  return rankGenerationModels({ ...input, capable: videoCapable });
}

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

/** A custom endpoint plus whether its API key is stored — the Settings list shape. */
export type CustomProviderInfo = CustomProvider & { hasKey: boolean };

/**
 * Payload to create (or replace by id) a custom endpoint from Settings. The key
 * is optional — many local servers (LM Studio / vLLM) need none; model labels
 * default to their ids.
 */
export type CustomProviderInput = {
  /** Stable local id; derived from the label when omitted. */
  id?: string;
  label: string;
  baseUrl: string;
  /** Model ids the endpoint serves. */
  modelIds: string[];
  /** Optional API key (stored in secrets under `custom:<id>`). */
  apiKey?: string;
};

/**
 * Human label for any provider id. Built-ins resolve through {@link getProvider};
 * a `custom:<id>` resolves against the supplied custom list (falling back to the
 * raw id). Used by the chat/status-bar selectors, which must not call the
 * built-in-only {@link getProvider} with a custom id (it throws).
 */
export function providerLabel(
  id: ProviderId,
  customProviders: readonly { id: string; label: string }[] = [],
): string {
  if (isBuiltinProviderId(id)) return getProvider(id).label;
  const local = parseCustomProviderId(id);
  return customProviders.find((c) => c.id === local)?.label ?? id;
}
