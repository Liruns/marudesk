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
import type { ToolSchema } from './tools';

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
  apiKey: string,
  baseUrl?: string,
): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId);
    case 'openai':
      return createOpenAI({ apiKey })(modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId);
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
