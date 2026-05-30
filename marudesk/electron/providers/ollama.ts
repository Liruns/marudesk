import type { ProposeResult } from '../../shared/composer';
import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import {
  MAX_TOKENS,
  SYSTEM_PROMPT,
  TOOL_INPUT_SCHEMA,
  TOOL_NAME,
  finishProposal,
} from './tool';

/**
 * Ollama (roadmap P3) — a local, keyless provider. Ollama exposes an
 * OpenAI-compatible Chat Completions endpoint at localhost:11434/v1, so the
 * one-shot `propose_patch` flow mirrors the OpenAI driver but with no auth header
 * and `max_tokens` (Ollama's field). Tool calling requires a tool-capable local
 * model (e.g. qwen2.5-coder); models that ignore the forced tool call surface as
 * a clean "did not call propose_patch" error rather than a crash.
 */

export const OLLAMA_BASE = 'http://localhost:11434';

type OllamaToolCall = {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
};
type OllamaResponse = {
  choices?: { message?: { content?: string | null; tool_calls?: OllamaToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

async function propose(
  _apiKey: string,
  model: string,
  userText: string,
): Promise<ProposeResult> {
  let httpResp: Response;
  try {
    httpResp = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: TOOL_NAME,
              description: 'Emit a minimal sequence of string-replace edits to fulfill the user request.',
              parameters: TOOL_INPUT_SCHEMA,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: TOOL_NAME } },
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Ollama request failed (is it running at ${OLLAMA_BASE}?): ${(err as Error).message}`,
    };
  }
  if (!httpResp.ok) {
    const body = await httpResp.text().catch(() => '');
    return { ok: false, reason: `Ollama HTTP ${httpResp.status}: ${body.slice(0, 400)}` };
  }
  let resp: OllamaResponse;
  try {
    resp = (await httpResp.json()) as OllamaResponse;
  } catch (err) {
    return { ok: false, reason: `Ollama response was not JSON: ${(err as Error).message}` };
  }
  const call = resp.choices?.[0]?.message?.tool_calls?.find((c) => c.function?.name === TOOL_NAME);
  if (!call) {
    const text = resp.choices?.[0]?.message?.content ?? '';
    return {
      ok: false,
      reason: `Ollama model did not call ${TOOL_NAME} (use a tool-capable model)${text ? ` (text: ${text.slice(0, 300)})` : ''}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch (err) {
    return { ok: false, reason: `Ollama tool arguments not JSON: ${(err as Error).message}` };
  }
  const u = resp.usage ?? {};
  return finishProposal(parsed, 'ollama', model, {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
  });
}

async function listModels(): Promise<ModelDef[]> {
  // Ollama's native tag list (no auth). Empty/unreachable → caller falls back to
  // the static catalog.
  const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!resp.ok) {
    throw new Error(`Ollama /api/tags returned HTTP ${resp.status}`);
  }
  const json = (await resp.json()) as { models?: { name?: string }[] };
  return (json.models ?? [])
    .map((m) => m.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .map((name) => ({ id: name, label: name }));
}

export const ollamaDriver: ProviderDriver = { propose, listModels };
