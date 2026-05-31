import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  tool,
  jsonSchema,
  type JSONSchema7,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { ProviderId } from '../../shared/providers';
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
      // xAI is OpenAI-compatible; an API key and an OAuth access token are both
      // sent as `Authorization: Bearer <token>` (no special headers / dialect).
      const token = auth.mode === 'oauth' ? auth.accessToken : apiKey;
      return createOpenAICompatible({
        name: 'xai',
        baseURL: XAI_BASE_URL,
        apiKey: token || undefined,
      })(modelId);
    }
    case 'ollama':
      // Local, keyless — Ollama exposes an OpenAI-compatible API on this port.
      return createOpenAICompatible({ name: 'ollama', baseURL: OLLAMA_BASE_URL })(modelId);
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
