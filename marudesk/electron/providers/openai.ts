import type { ProposeResult } from '../../shared/composer';
import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import {
  MAX_TOKENS,
  ProviderAuthError,
  SYSTEM_PROMPT,
  TOOL_INPUT_SCHEMA,
  TOOL_NAME,
  finishProposal,
  isAuthStatus,
  prettifyId,
} from './tool';

type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
type OpenAIChoice = {
  message: {
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
};
type OpenAIResponse = {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

async function propose(
  apiKey: string,
  model: string,
  userText: string,
): Promise<ProposeResult> {
  let httpResp: Response;
  try {
    httpResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: TOOL_NAME,
              description:
                'Emit a minimal sequence of string-replace edits to fulfill the user request.',
              parameters: TOOL_INPUT_SCHEMA,
            },
          },
        ],
        tool_choice: {
          type: 'function',
          function: { name: TOOL_NAME },
        },
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `OpenAI request failed: ${(err as Error).message}`,
    };
  }
  if (!httpResp.ok) {
    const body = await httpResp.text().catch(() => '');
    return {
      ok: false,
      reason: `OpenAI HTTP ${httpResp.status}: ${body.slice(0, 400)}`,
    };
  }
  let resp: OpenAIResponse;
  try {
    resp = (await httpResp.json()) as OpenAIResponse;
  } catch (err) {
    return {
      ok: false,
      reason: `OpenAI response was not JSON: ${(err as Error).message}`,
    };
  }
  const call = resp.choices?.[0]?.message?.tool_calls?.find(
    (c) => c.type === 'function' && c.function?.name === TOOL_NAME,
  );
  if (!call) {
    const text = resp.choices?.[0]?.message?.content ?? '';
    return {
      ok: false,
      reason: `OpenAI did not call ${TOOL_NAME}${text ? ` (text: ${text.slice(0, 400)})` : ''}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch (err) {
    return {
      ok: false,
      reason: `OpenAI tool arguments not JSON: ${(err as Error).message}`,
    };
  }
  const u = resp.usage ?? {};
  return finishProposal(parsed, 'openai', model, {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
  });
}

async function listModels(apiKey: string): Promise<ModelDef[]> {
  const resp = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200);
    const message = `OpenAI /v1/models returned HTTP ${resp.status}: ${detail}`;
    if (isAuthStatus(resp.status)) throw new ProviderAuthError(message, resp.status);
    throw new Error(message);
  }
  const json = (await resp.json()) as { data?: { id: string }[] };
  const items = json.data ?? [];
  // Keep only chat-compatible families to avoid embedding/whisper noise.
  const keep = (id: string): boolean =>
    /^(gpt-|o\d|chatgpt|claude-)/i.test(id) &&
    !/embedding|whisper|tts|dall|image/i.test(id);
  return items
    .filter((m) => typeof m.id === 'string' && keep(m.id))
    .map((m) => ({ id: m.id, label: prettifyId(m.id) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const openaiDriver: ProviderDriver = { propose, listModels };
