import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import {
  APICallError,
  tool,
  jsonSchema,
  type JSONSchema7,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from 'ai';
import type { ProviderId } from '../../shared/providers';
import { toMessage } from '../../shared/to-message';
import { scrubText } from '../../shared/scrub';
import { OLLAMA_BASE } from '../providers/ollama';
import { ANTHROPIC_OAUTH_HEADERS, OPENAI_CODEX_BASE_URL, codexHeaders } from '../oauth/config';
import { chatgptAccountId } from '../oauth/jwt';
import { codeAssistFetch } from '../oauth/google-code-assist';
import {
  getGitLabDuoDirectAccess,
  GITLAB_DUO_ANTHROPIC_PROXY,
  GITLAB_DUO_OPENAI_PROXY,
} from '../auth/gitlab-duo';
import type { ToolSchema } from './tools';
import { normalizeToolSchema } from './tools/normalize-schema';
import { classifyStreamError, backoffDelayMs } from './stream-error.ts';

/**
 * How a turn authenticates to the provider: a stored API key, or an OAuth
 * subscription access token (Claude Pro/Max — docs/oauth-providers-design.md).
 * loop.ts resolves this once per turn (OAuth preferred when connected) and the
 * agent path is otherwise auth-agnostic.
 */
export type ModelAuth =
  | { mode: 'api-key'; apiKey: string }
  | { mode: 'oauth'; accessToken: string };

/**
 * The agent's model layer (docs/agentic-chat-v2-design.md §4). Replaces the
 * hand-rolled per-provider drivers with the Vercel AI SDK: loop.ts makes ONE
 * `streamText` call per step and drives the multi-turn loop itself. The bridged
 * tools carry no `execute`, so the SDK returns each tool call back to the loop —
 * which runs it through the existing validated executor and can park for
 * approval / ask_user between calls (the manual step-driven pattern). Adding a
 * provider is one OPENAI_COMPAT_PROVIDERS entry (OpenAI-compatible endpoints) or
 * one `case` in buildModel (bespoke SDK/auth); streaming, tool-calling, and
 * provider-native message mapping all come from the SDK (no more bespoke
 * transcript translators).
 */

/** The running transcript is now the SDK's own provider-agnostic message shape. */
export type { ModelMessage };

const XAI_BASE_URL = 'https://api.x.ai/v1';

/**
 * Providers that are plain OpenAI-compatible HTTP endpoints — they differ only
 * by base URL (plus optional identifying headers), so {@link buildModel} routes
 * them all through one `createOpenAICompatible` path. Adding such a provider is
 * ONE entry here plus its catalog entry in shared/providers.ts; keyless local
 * endpoints (Ollama) simply have no stored key. Providers with their own SDK,
 * auth scheme, or request envelope (anthropic / openai / google / xai /
 * openai-codex / google-caa) keep explicit cases in buildModel instead.
 */
const OPENAI_COMPAT_PROVIDERS: Partial<
  Record<ProviderId, { baseURL: string; headers?: Record<string, string> }>
> = {
  // Local, keyless — Ollama exposes an OpenAI-compatible API next to its native
  // one; derived from the provider driver's base so the two never drift apart.
  ollama: { baseURL: `${OLLAMA_BASE}/v1` },
  // Z.ai's general OpenAI-compatible API. A GLM Coding Plan key instead needs
  // api.z.ai/api/coding/paas/v4 — that's wired as a custom endpoint, not here.
  zai: { baseURL: 'https://api.z.ai/api/paas/v4' },
  // OpenCode's curated gateway (OpenCode Zen).
  opencode: { baseURL: 'https://opencode.ai/zen/v1' },
  // OpenRouter gateway; the optional ranking headers identify the app on
  // openrouter.ai (harmless when omitted).
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    headers: { 'HTTP-Referer': 'https://marudesk.app', 'X-Title': 'marudesk' },
  },
  // OpenAI-compatible API-key gateways/vendors (docs/provider-expansion-plan.md).
  groq: { baseURL: 'https://api.groq.com/openai/v1' },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1' },
  mistral: { baseURL: 'https://api.mistral.ai/v1' },
  deepseek: { baseURL: 'https://api.deepseek.com/v1' },
  together: { baseURL: 'https://api.together.xyz/v1' },
  fireworks: { baseURL: 'https://api.fireworks.ai/inference/v1' },
  moonshot: { baseURL: 'https://api.moonshot.ai/v1' },
  nvidia: { baseURL: 'https://integrate.api.nvidia.com/v1' },
  venice: { baseURL: 'https://api.venice.ai/api/v1' },
  huggingface: { baseURL: 'https://router.huggingface.co/v1' },
  // NB: gitlab-duo is NOT a plain compat endpoint — it needs a PAT→direct-access
  // token exchange and routes Claude vs GPT models to different proxy dialects,
  // so it gets its own case in buildModel below.
};

/**
 * Known-dead / hallucinated model slugs mapped to guidance. A second line of
 * defense behind the picker + catalog (docs/agentic-chat-v4-design.md §A3): even
 * if a stale id reaches buildModel — a persisted selection, an out-of-date OAuth
 * pin, a hand-typed custom-endpoint id — we fail with a clear, actionable message
 * instead of letting the provider return an opaque 400/404. Keyed `provider:id`.
 */
const RETIRED_MODELS: Record<string, string> = {
  'xai:grok-2': 'grok-2 was retired by xAI. Use grok-4.3.',
  'xai:grok-3': 'grok-3 was retired by xAI on 2026-05-15. Use grok-4.3.',
  'xai:grok-3-mini': 'grok-3-mini was retired by xAI on 2026-05-15. Use grok-4.3.',
  'xai:grok-4': 'grok-4 was retired by xAI on 2026-05-15. Use grok-4.3.',
  'xai:grok-4-0709': 'grok-4-0709 was retired by xAI on 2026-05-15. Use grok-4.3.',
  'xai:grok-code-fast-1':
    'grok-code-fast-1 was retired by xAI on 2026-05-15. Use grok-build-0.1.',
  'openai:gpt-5-turbo': "gpt-5-turbo doesn't exist. Use gpt-5 or gpt-5-mini.",
  'google:gemini-pro': 'gemini-pro is retired. Use gemini-2.5-pro.',
  'google:gemini-1.5-pro': 'gemini-1.5-pro is retired. Use gemini-2.5-pro.',
  'google:gemini-1.5-flash': 'gemini-1.5-flash is retired. Use gemini-2.5-flash.',
};

/** Reject an empty or known-dead model id before the network call. */
export function assertModelUsable(provider: ProviderId, modelId: string): void {
  if (!modelId || !modelId.trim()) {
    throw new Error('No model selected — pick one from the chat composer.');
  }
  const retired = RETIRED_MODELS[`${provider}:${modelId}`];
  if (retired) throw new Error(retired);
}

/**
 * Turn a provider/SDK error into a human-readable, actionable chat message. The
 * AI SDK's APICallError carries the HTTP status + response body; map the common
 * cases (bad/retired model, auth, rate limit, server) and fall back to the raw
 * message otherwise — see docs/agentic-chat-v4-design.md §A3.
 */
export function humanizeModelError(
  err: unknown,
  provider: ProviderId,
  modelId: string,
): string {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    const body = typeof err.responseBody === 'string' ? err.responseBody : '';
    const snippet = body ? ` — ${scrubText(body).slice(0, 300)}` : '';
    const who = String(provider);
    if (status === 401 || status === 403) {
      return `${who} rejected the credentials (${status}). Check the API key in Settings, or reconnect the account.${snippet}`;
    }
    if (status === 404) {
      return `${who} has no model "${modelId}" (404). It may be retired or unavailable on this account.${snippet}`;
    }
    if (status === 400 && /model|not supported|not found|unknown|deprecat/i.test(body)) {
      return `${who} rejected the model "${modelId}" (400). It may be retired, misspelled, or not on this plan.${snippet}`;
    }
    if (status === 429) {
      return `${who} rate-limited the request (429). Wait a moment and retry, or check your plan quota.${snippet}`;
    }
    if (typeof status === 'number' && status >= 500) {
      return `${who} had a server error (${status}). Try again shortly.${snippet}`;
    }
    return `${who} request failed${status ? ` (${status})` : ''}: ${scrubText(err.message)}${snippet}`;
  }
  return scrubText(toMessage(err));
}

/**
 * Errors worth failing over to another model: rate-limit / quota (429) and
 * transient server / overload (5xx, incl. Anthropic's 529). NOT auth (401/403)
 * or bad-request (400/404) — a different provider won't fix a bad key or a
 * malformed request, and silently masking those would hide a real misconfig.
 */
export function isFailoverError(err: unknown): boolean {
  if (!APICallError.isInstance(err)) return false;
  const s = err.statusCode;
  return s === 429 || (typeof s === 'number' && s >= 500);
}

/**
 * A fetch that forces `headers` onto the request AFTER the SDK builds it. The AI
 * SDK overrides `user-agent` set via provider config with its own (`ai/x …`), but
 * the subscription backends reject that: the Codex backend 403s behind Cloudflare
 * without `codex_cli_rs`, and Anthropic OAuth 4xxs without `claude-cli`. Setting
 * them here guarantees delivery (the SDK-set Authorization is left intact).
 */
function fetchWithForcedHeaders(forced: Record<string, string>): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(forced)) headers.set(k, v);
    return globalThis.fetch(input, { ...init, headers });
  };
}

/**
 * Build an AI SDK model instance for the resolved provider/model/key. Custom
 * OpenAI-compatible endpoints (OpenRouter / LM Studio / vLLM …) arrive as a
 * `custom:<id>` provider and reuse the same `createOpenAICompatible` path with a
 * caller-supplied `baseUrl` (resolved from the stored config in loop.ts); their
 * key is optional, since many local servers need none.
 */
export function buildModel(
  provider: ProviderId,
  modelId: string,
  auth: ModelAuth,
  baseUrl?: string,
): LanguageModel {
  assertModelUsable(provider, modelId);
  // Only Anthropic has an OAuth path; everywhere else `auth` is an API key (or
  // empty, for keyless/local endpoints).
  const apiKey = auth.mode === 'api-key' ? auth.apiKey : '';
  // Plain OpenAI-compatible endpoints all share one path — see the table above.
  const compat = OPENAI_COMPAT_PROVIDERS[provider];
  if (compat) {
    return createOpenAICompatible({
      name: provider,
      baseURL: compat.baseURL,
      apiKey: apiKey || undefined,
      ...(compat.headers ? { headers: compat.headers } : {}),
    })(modelId);
  }
  switch (provider) {
    case 'anthropic':
      if (auth.mode === 'oauth') {
        // Subscription login: Bearer auth (the SDK's `authToken` sends
        // `Authorization: Bearer` and omits `x-api-key`) + the Claude-Code beta
        // headers. The required system-prompt prefix is added in loop.ts. The
        // headers are also forced via fetch because the SDK clobbers `user-agent`
        // and Anthropic's OAuth endpoint 4xxs without `claude-cli`.
        return createAnthropic({
          authToken: auth.accessToken,
          headers: ANTHROPIC_OAUTH_HEADERS,
          fetch: fetchWithForcedHeaders(ANTHROPIC_OAUTH_HEADERS),
        })(modelId);
      }
      return createAnthropic({ apiKey })(modelId);
    case 'openai':
      return createOpenAI({ apiKey })(modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case 'openai-codex': {
      // EXPERIMENTAL: ChatGPT subscription via the codex backend (Responses API).
      // The access token is the Bearer; account id + originator headers mirror the
      // codex CLI. store:false + omitting max_output_tokens are set in loop.ts.
      if (auth.mode !== 'oauth') throw new Error('openai-codex requires an OAuth connection');
      const codexHdrs = codexHeaders(chatgptAccountId(auth.accessToken));
      return createOpenAI({
        baseURL: OPENAI_CODEX_BASE_URL,
        apiKey: auth.accessToken,
        headers: codexHdrs,
        // Force the headers: the SDK overrides `user-agent`, but the codex backend
        // 403s behind Cloudflare without `codex_cli_rs`.
        fetch: fetchWithForcedHeaders(codexHdrs),
      }).responses(modelId);
    }
    case 'google-caa': {
      // EXPERIMENTAL: personal-account Gemini via the Code-Assist backend. The
      // custom fetch handles auth (Bearer) + the {project,model,request} envelope,
      // so the apiKey here is a dummy the SDK requires but never uses.
      if (auth.mode !== 'oauth') throw new Error('google-caa requires an OAuth connection');
      return createGoogleGenerativeAI({
        apiKey: 'oauth',
        fetch: codeAssistFetch(auth.accessToken),
      })(modelId);
    }
    case 'xai': {
      // xAI's current Grok 4.3 image-understanding docs use the Responses API.
      // The provider handles xAI's `input_image` payload shape while preserving
      // the same Bearer token auth for API keys and OAuth access tokens.
      const token = auth.mode === 'oauth' ? auth.accessToken : apiKey;
      return createXai({ baseURL: XAI_BASE_URL, apiKey: token || undefined }).responses(modelId);
    }
    case 'github-copilot': {
      // GitHub Copilot subscription. The device-flow OAuth token is used directly
      // (no JWT exchange — ref: Yeachan-Heo/gajae-code · utils/oauth/github-copilot),
      // but Copilot is DIALECT-ROUTED by model and requires editor-identifying
      // headers (incl. a User-Agent — Copilot rejects unknown clients). Per the
      // reference catalog: Claude models speak anthropic-messages, the gpt-5 /
      // o-series speak the Responses API, and everything else (gpt-4.x, gemini,
      // grok-code) speaks chat completions. Routing the default claude-* model
      // through chat completions — as before — is why Copilot failed to connect.
      if (auth.mode !== 'oauth') throw new Error('github-copilot requires an OAuth connection');
      const COPILOT_BASE = 'https://api.githubcopilot.com';
      const token = auth.accessToken;
      // Copilot rejects unrecognized clients, and the SDK clobbers `user-agent` set
      // via config — so force the editor headers after the SDK builds the request.
      // `X-Initiator: agent` marks the agent loop's multi-step turns so they don't
      // bill as premium user interactions.
      const copilotFetch = fetchWithForcedHeaders({
        'User-Agent': 'GitHubCopilotChat/0.26.7',
        'Editor-Version': 'marudesk/1.0',
        'Editor-Plugin-Version': 'marudesk/1.0',
        'Copilot-Integration-Id': 'vscode-chat',
        'Openai-Intent': 'conversation-edits',
        'X-Initiator': 'agent',
      });
      if (/^claude/i.test(modelId)) {
        // Anthropic passthrough at /v1/messages (SDK appends /messages to baseURL).
        return createAnthropic({ baseURL: `${COPILOT_BASE}/v1`, authToken: token, fetch: copilotFetch })(modelId);
      }
      if (/^(gpt-5|o[0-9])/i.test(modelId)) {
        return createOpenAI({ baseURL: COPILOT_BASE, apiKey: token, fetch: copilotFetch }).responses(modelId);
      }
      return createOpenAICompatible({
        name: 'github-copilot',
        baseURL: COPILOT_BASE,
        apiKey: token,
        fetch: copilotFetch,
      })(modelId);
    }
    case 'google-vertex': {
      // Vertex AI: ADC-based auth with Bearer token. The access token is
      // resolved externally (electron/auth/vertex-adc.ts). Vertex requires
      // Authorization: Bearer, not an API key query param — use a custom fetch.
      const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
      if (!project) throw new Error('google-vertex requires GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT) env var');
      const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
      const vertexBase = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google`;
      const vertexToken = auth.mode === 'oauth' ? auth.accessToken : apiKey;
      const vertexFetch: typeof globalThis.fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${vertexToken}`);
        return globalThis.fetch(input, { ...init, headers });
      };
      return createGoogleGenerativeAI({
        apiKey: 'vertex-bearer',
        fetch: vertexFetch,
        baseURL: vertexBase,
      })(modelId);
    }
    case 'amazon-bedrock': {
      // Bedrock: SigV4-authenticated. Every request is signed at the fetch
      // layer using the AWS credentials resolved by resolve-auth.
      const bedrockRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
      const bedrockBase = `https://bedrock-runtime.${bedrockRegion}.amazonaws.com`;
      const bedrockFetch: typeof globalThis.fetch = async (input, init) => {
        const { signBedrockRequest, resolveAwsCredentials } = await import('../auth/aws-sigv4');
        const creds = await resolveAwsCredentials();
        if (!creds) throw new Error('no AWS credentials for Bedrock signing');
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const parsed = new URL(urlStr);
        const signed = await signBedrockRequest(
          init?.method ?? 'POST',
          parsed.pathname + parsed.search,
          typeof init?.body === 'string' ? init.body : undefined,
          creds,
          bedrockRegion,
        );
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(signed.headers)) headers.set(k, v);
        return globalThis.fetch(input, { ...init, headers });
      };
      return createOpenAICompatible({
        name: 'amazon-bedrock',
        baseURL: bedrockBase,
        apiKey: 'bedrock-sigv4',
        fetch: bedrockFetch,
      })(modelId);
    }
    case 'gitlab-duo': {
      // GitLab Duo: a PAT (api scope) is exchanged for a short-lived direct-access
      // token, which (plus GitLab's returned headers) authenticates the AI gateway
      // proxy. Claude models go to the anthropic-dialect proxy, everything else to
      // the openai-dialect proxy — see electron/auth/gitlab-duo.ts. The async fetch
      // wrapper performs (and caches) the exchange and injects the credentials, so
      // the apiKey passed to the SDK is a placeholder it never sends.
      if (auth.mode !== 'api-key' || !apiKey) {
        throw new Error('gitlab-duo requires a GitLab access token (PAT with api scope)');
      }
      const pat = apiKey;
      const isClaude = /^claude/i.test(modelId);
      const gitlabFetch: typeof globalThis.fetch = async (input, init) => {
        const access = await getGitLabDuoDirectAccess(pat);
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(access.headers)) headers.set(k, v);
        headers.delete('x-api-key');
        headers.set('authorization', `Bearer ${access.token}`);
        return globalThis.fetch(input, { ...init, headers });
      };
      if (isClaude) {
        return createAnthropic({
          baseURL: GITLAB_DUO_ANTHROPIC_PROXY,
          authToken: 'gitlab-duo',
          fetch: gitlabFetch,
        })(modelId);
      }
      return createOpenAICompatible({
        name: 'gitlab-duo',
        baseURL: GITLAB_DUO_OPENAI_PROXY,
        apiKey: 'gitlab-duo',
        fetch: gitlabFetch,
      })(modelId);
    }
    case 'azure-openai': {
      // Azure OpenAI: endpoint + API key. api-version must be a URL query
      // param (not a header); the deployment name is in the base URL path so
      // we use a stub modelId ('_') to prevent the SDK from appending it again.
      const azureEndpoint = baseUrl
        ?? process.env.AZURE_OPENAI_ENDPOINT
        ?? '';
      if (!azureEndpoint) throw new Error('azure-openai requires AZURE_OPENAI_ENDPOINT or a custom base URL');
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2025-04-01-preview';
      const azureBase = `${azureEndpoint.replace(/\/+$/, '')}/openai/deployments/${modelId}`;
      const azureFetch: typeof globalThis.fetch = (input, init) => {
        const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL((input as Request).url);
        url.searchParams.set('api-version', apiVersion);
        const headers = new Headers(init?.headers);
        headers.set('api-key', apiKey || '');
        return globalThis.fetch(url, { ...init, headers });
      };
      return createOpenAICompatible({
        name: 'azure-openai',
        baseURL: azureBase,
        apiKey: apiKey || 'azure',
        fetch: azureFetch,
      })('_');
    }
    default: {
      // custom:<id> — a user-configured OpenAI-compatible endpoint.
      if (!baseUrl) throw new Error(`custom provider ${provider} has no base URL`);
      return createOpenAICompatible({
        name: provider,
        baseURL: baseUrl,
        apiKey: apiKey || undefined,
      })(modelId);
    }
  }
}

/**
 * Bridge marudesk's JSON-Schema tool definitions into AI SDK tools. No `execute`
 * is attached on purpose: streamText then surfaces each tool call back to the
 * loop, which runs it through the existing validated executor (and can park for
 * approval / ask_user between calls).
 *
 * CACHE-1 (docs/agent-port-plan.md): when `opts.cacheable` is true, attach an
 * Anthropic `cacheControl` breakpoint to ONLY the LAST tool. MCP-1 made the tail
 * stable — the last entry is always the fixed built-in `ASK_USER_DEF` — so this
 * one breakpoint covers the whole system+tools prefix as a single cache slot.
 * `@ai-sdk/anthropic`'s prepareTools reads each tool's
 * `providerOptions.anthropic.cacheControl` and emits `cache_control` on the wire
 * (verified against the installed 3.0.x). Non-Anthropic providers ignore the
 * extra option, and the no-opts / `cacheable: false` / empty-schema paths attach
 * nothing — byte-identical to the prior behavior.
 *
 * PROV-1 (docs/agent-port-plan.md): when `opts.provider` is set, each tool's
 * input schema is run through {@link normalizeToolSchema} BEFORE `jsonSchema()`
 * wrapping, so google/openai see a provider-shaped schema (fail-open — a
 * normalizer error returns the original). Undefined provider (subagent-runtime,
 * harnesses) is pass-through identity, so those call sites are unaffected.
 */
export function aiTools(schemas: ToolSchema[], opts?: { cacheable?: boolean; provider?: ProviderId }): ToolSet {
  const lastIndex = schemas.length - 1;
  const cacheLast = opts?.cacheable === true && schemas.length > 0;
  const provider = opts?.provider;
  return Object.fromEntries(
    schemas.map((t, i) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(normalizeToolSchema(provider, t.inputSchema) as JSONSchema7),
        ...(cacheLast && i === lastIndex
          ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
          : {}),
      }),
    ]),
  ) as ToolSet;
}

/** The Anthropic ephemeral prompt-cache breakpoint we attach to a cacheable prefix. */
const ANTHROPIC_CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

/**
 * CACHE-1 (docs/agent-port-plan.md): cache the LARGE, STABLE system prompt.
 *
 * `aiTools` already caches the tools block; this caches the system block. The AI
 * SDK's `system` accepts a {@link SystemModelMessage} (not just a string) whose
 * `providerOptions.anthropic.cacheControl` `@ai-sdk/anthropic` reads and emits as
 * `cache_control` on the system text block (verified against the installed 3.0.x).
 * Tools precede system+messages in request order, so the tools breakpoint alone
 * caches only tools — without this, the system prompt is re-billed at full input
 * price every step. When `cacheable` is false (non-Anthropic providers) the plain
 * string is returned unchanged, so those request paths are byte-identical.
 */
export function cachedSystem(system: string, cacheable: boolean): string | SystemModelMessage {
  if (!cacheable) return system;
  return { role: 'system', content: system, providerOptions: ANTHROPIC_CACHE_BREAKPOINT };
}

/**
 * CACHE-1 (docs/agent-port-plan.md): cache the GROWING message-history prefix.
 *
 * The whole transcript is re-sent every step, so without a breakpoint the message
 * history is re-billed at full input price each turn. Anthropic caches the prefix
 * up to (and including) a `cache_control` breakpoint, so we attach one to the LAST
 * message BEFORE the volatile tail — the second-to-last message. Placing it on the
 * very last message would move the breakpoint every step (the tail is what just
 * changed), defeating the cache; the second-to-last is a prefix boundary that was
 * already stable last step, so the prefix up to it hits the cache. Combined with
 * the tools + system breakpoints this is 3 breakpoints total — within Anthropic's
 * limit of 4. Returns a shallow copy with the chosen message's `providerOptions`
 * merged (never mutating the caller's transcript); fewer than two messages, or a
 * non-cacheable provider, returns the original array untouched.
 */
export function withMessagePrefixCache(
  messages: ModelMessage[],
  cacheable: boolean,
): ModelMessage[] {
  if (!cacheable || messages.length < 2) return messages;
  const idx = messages.length - 2;
  const next = messages.slice();
  next[idx] = withCacheBreakpoint(next[idx]);
  return next;
}

/**
 * Return a shallow copy of one message with the Anthropic cache breakpoint merged
 * into its `providerOptions`. Generic over the concrete message variant so the
 * `role`/`content` discriminant correlation is preserved (spreading the bare
 * {@link ModelMessage} union would widen both and break strict assignability).
 */
function withCacheBreakpoint<T extends ModelMessage>(message: T): T {
  return {
    ...message,
    providerOptions: { ...message.providerOptions, ...ANTHROPIC_CACHE_BREAKPOINT },
  };
}

/* ── Streaming error recovery ──────────────────────────────────────────── */

const MAX_STREAM_RETRIES = 2;

/**
 * Whether a failed stream call should be retried on the SAME provider. Delegates
 * to the shared classifier ({@link classifyStreamError}) so this and the agent
 * loop agree on what "transient" means — a `retry` action (429 rate-limit /
 * overload / 5xx / network) is retryable; quota-exhaustion, overflow, auth, and
 * bad-request are not (the loop routes those to failover / compaction / surface).
 */
export function isRetryableStreamError(err: unknown): boolean {
  return classifyStreamError(err).action === 'retry';
}

/**
 * Retry a streaming call on transient errors with exponential backoff, honoring a
 * server-supplied `Retry-After` when present (item 1). Used by the non-loop stream
 * paths (subagent / media generation); the main loop drives its own classifier-
 * based retry/compact/failover routing inline so it can do more than retry-in-place.
 */
export async function withStreamRetry<T>(
  fn: () => Promise<T>,
  provider: ProviderId,
  modelId: string,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const klass = classifyStreamError(err);
      if (klass.action !== 'retry' || attempt === MAX_STREAM_RETRIES) break;
      const delay = klass.retryAfterMs ?? backoffDelayMs(attempt);
      console.warn(
        `[agent] ${provider}/${modelId} stream error (attempt ${attempt + 1}/${
          MAX_STREAM_RETRIES + 1
        }), retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
