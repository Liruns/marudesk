import { PROVIDERS } from './provider-catalog.ts';
export { PROVIDERS, MODELS } from './provider-catalog.ts';

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
  | 'opencode'
  // OpenAI-compatible API-key gateways/vendors absorbed from the reference
  // ecosystems (hermes-agent / opencode) — see docs/provider-expansion-plan.md.
  // Each speaks the OpenAI dialect (Bearer key + /models), so they slot into the
  // same createOpenAICompatible path as zai/opencode with just a base URL.
  | 'openrouter'
  | 'groq'
  | 'cerebras'
  | 'mistral'
  | 'deepseek'
  | 'together'
  | 'fireworks'
  // More OpenAI-compatible API-key vendors absorbed from the reference catalog
  // (Yeachan-Heo/gajae-code · packages/ai). Same Bearer-key + /models path.
  | 'moonshot'
  | 'nvidia'
  | 'venice'
  | 'huggingface'
  // Enterprise / subscription providers — each has a bespoke auth mechanism
  // (device flow, ADC, SigV4, direct access token) distinct from the standard
  // PKCE OAuth or Bearer-key paths above.
  | 'github-copilot'
  | 'google-vertex'
  | 'amazon-bedrock'
  | 'gitlab-duo'
  | 'azure-openai';

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
   * Console/dashboard URL where a user issues an API key for this provider.
   * When set, settings renders the key hint as a clickable "Get a key" link
   * (opened externally via the window-open handler → safe-open). OAuth-only,
   * keyless (Ollama), and ambient-credential providers (Vertex ADC / Bedrock /
   * Azure endpoint) omit it and fall back to the plain text hint.
   */
  apiKeyUrl?: string;
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
export type OAuthFlow = 'manual-paste' | 'loopback' | 'device-code';

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
  /**
   * Per-call output-token ceiling when the provider documents one above the
   * agent's flat 4096 floor (SECOND-PASS item 1). Opus/Sonnet 4.x admit 64K and
   * the gpt-5 family 128K, so a large answer is silently truncated at 4096 unless
   * the cap is lifted here. Omitted where unknown — the agent then keeps the 4096
   * floor (see reasoning-config.maxTokensForTurn).
   */
  maxOutputTokens?: number;
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

export const DEFAULT_MODEL_KEY = modelKey('anthropic', 'claude-sonnet-4-6');

/* ── media-generation capability inference + ranking: ./provider-capabilities ── */
export {
  inferImageGenerationCapability,
  inferVideoGenerationCapability,
  mergeInferredModelCapabilities,
  rankImageGenerationModels,
  rankVideoGenerationModels,
} from './provider-capabilities.ts';

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
