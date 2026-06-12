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
  type ToolSet,
} from 'ai';
import type { ProviderId } from '../../shared/providers';
import { toMessage } from '../../shared/to-message';
import { OLLAMA_BASE } from '../providers/ollama';
import { ANTHROPIC_OAUTH_HEADERS, OPENAI_CODEX_BASE_URL, codexHeaders } from '../oauth/config';
import { chatgptAccountId } from '../oauth/jwt';
import { codeAssistFetch } from '../oauth/google-code-assist';
import type { ToolSchema } from './tools';

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
  // GitLab Duo proxies to underlying providers via its cloud endpoints.
  // PAT auth is passed as Bearer key.
  'gitlab-duo': { baseURL: 'https://cloud.gitlab.com/ai/v1' },
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
    const snippet = body ? ` — ${body.slice(0, 300)}` : '';
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
    return `${who} request failed${status ? ` (${status})` : ''}: ${err.message}${snippet}`;
  }
  return toMessage(err);
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
        // headers. The required system-prompt prefix is added in loop.ts.
        return createAnthropic({
          authToken: auth.accessToken,
          headers: ANTHROPIC_OAUTH_HEADERS,
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
      return createOpenAI({
        baseURL: OPENAI_CODEX_BASE_URL,
        apiKey: auth.accessToken,
        headers: codexHeaders(chatgptAccountId(auth.accessToken)),
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
      // GitHub Copilot: the device-flow access token is exchanged for a
      // short-lived Copilot token via the integrations API, then used against
      // the OpenAI-compatible completions endpoint. For now, pass the OAuth
      // token directly — the Copilot proxy handles the exchange server-side.
      if (auth.mode !== 'oauth') throw new Error('github-copilot requires an OAuth connection');
      return createOpenAICompatible({
        name: 'github-copilot',
        baseURL: 'https://api.githubcopilot.com',
        apiKey: auth.accessToken,
        headers: {
          'Copilot-Integration-Id': 'vscode-chat',
          'Editor-Version': 'marudesk/1.0',
          'Openai-Intent': 'conversation-panel',
        },
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
 */
export function aiTools(schemas: ToolSchema[]): ToolSet {
  return Object.fromEntries(
    schemas.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
      }),
    ]),
  ) as ToolSet;
}

/* ── Streaming error recovery ──────────────────────────────────────────── */

const MAX_STREAM_RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

export function isRetryableStreamError(err: unknown): boolean {
  if (APICallError.isInstance(err)) {
    return typeof err.statusCode === 'number' && RETRYABLE_STATUS.has(err.statusCode);
  }
  if (err instanceof Error && /timeout|ECONNRESET|EPIPE|fetch failed/i.test(err.message)) {
    return true;
  }
  return false;
}

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
      if (!isRetryableStreamError(err) || attempt === MAX_STREAM_RETRIES) break;
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
