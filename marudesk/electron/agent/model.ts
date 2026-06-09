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
 * provider is one `case` here; streaming, tool-calling, and provider-native
 * message mapping all come from the SDK (no more bespoke transcript translators).
 */

/** The running transcript is now the SDK's own provider-agnostic message shape. */
export type { ModelMessage };

const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
const XAI_BASE_URL = 'https://api.x.ai/v1';
// Z.ai's general OpenAI-compatible API. A GLM Coding Plan key instead needs
// api.z.ai/api/coding/paas/v4 — that's wired as a custom endpoint, not here.
const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
// OpenCode's curated gateway (OpenCode Zen), OpenAI-compatible.
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
// OpenAI-compatible API-key gateways/vendors (docs/provider-expansion-plan.md).
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';

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
    case 'ollama':
      // Local, keyless — Ollama exposes an OpenAI-compatible API on this port.
      return createOpenAICompatible({ name: 'ollama', baseURL: OLLAMA_BASE_URL })(modelId);
    case 'zai':
      // Z.ai (GLM) — OpenAI-compatible, Bearer API key.
      return createOpenAICompatible({
        name: 'zai',
        baseURL: ZAI_BASE_URL,
        apiKey: apiKey || undefined,
      })(modelId);
    case 'opencode':
      // OpenCode Zen gateway — OpenAI-compatible, Bearer API key.
      return createOpenAICompatible({
        name: 'opencode',
        baseURL: OPENCODE_BASE_URL,
        apiKey: apiKey || undefined,
      })(modelId);
    case 'openrouter':
      // OpenRouter gateway — OpenAI-compatible. The optional ranking headers
      // identify the app on openrouter.ai (harmless when omitted).
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: OPENROUTER_BASE_URL,
        apiKey: apiKey || undefined,
        headers: { 'HTTP-Referer': 'https://marudesk.app', 'X-Title': 'marudesk' },
      })(modelId);
    case 'groq':
      return createOpenAICompatible({
        name: 'groq',
        baseURL: GROQ_BASE_URL,
        apiKey: apiKey || undefined,
      })(modelId);
    case 'cerebras':
      return createOpenAICompatible({
        name: 'cerebras',
        baseURL: CEREBRAS_BASE_URL,
        apiKey: apiKey || undefined,
      })(modelId);
    case 'mistral':
      return createOpenAICompatible({
        name: 'mistral',
        baseURL: MISTRAL_BASE_URL,
        apiKey: apiKey || undefined,
      })(modelId);
    case 'deepseek':
      return createOpenAICompatible({
        name: 'deepseek',
        baseURL: DEEPSEEK_BASE_URL,
        apiKey: apiKey || undefined,
      })(modelId);
    case 'together':
      return createOpenAICompatible({
        name: 'together',
        baseURL: TOGETHER_BASE_URL,
        apiKey: apiKey || undefined,
      })(modelId);
    case 'fireworks':
      return createOpenAICompatible({
        name: 'fireworks',
        baseURL: FIREWORKS_BASE_URL,
        apiKey: apiKey || undefined,
      })(modelId);
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
