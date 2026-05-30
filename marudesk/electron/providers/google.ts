import type { ProposeResult } from '../../shared/composer';
import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import {
  MAX_TOKENS,
  SYSTEM_PROMPT,
  TOOL_NAME,
  finishProposal,
  geminiSchema,
  prettifyId,
  TOOL_INPUT_SCHEMA,
} from './tool';

type GeminiPart =
  | { text?: string }
  | { functionCall?: { name: string; args: unknown } };
type GeminiCandidate = { content?: { parts?: GeminiPart[] } };
type GeminiResponse = {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
};

async function propose(
  apiKey: string,
  model: string,
  userText: string,
): Promise<ProposeResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let httpResp: Response;
  try {
    httpResp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: TOOL_NAME,
                description:
                  'Emit a minimal sequence of string-replace edits to fulfill the user request.',
                parameters: geminiSchema(TOOL_INPUT_SCHEMA),
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [TOOL_NAME],
          },
        },
        generationConfig: { maxOutputTokens: MAX_TOKENS },
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Gemini request failed: ${(err as Error).message}`,
    };
  }
  if (!httpResp.ok) {
    const body = await httpResp.text().catch(() => '');
    return {
      ok: false,
      reason: `Gemini HTTP ${httpResp.status}: ${body.slice(0, 400)}`,
    };
  }
  let resp: GeminiResponse;
  try {
    resp = (await httpResp.json()) as GeminiResponse;
  } catch (err) {
    return {
      ok: false,
      reason: `Gemini response was not JSON: ${(err as Error).message}`,
    };
  }
  if (resp.promptFeedback?.blockReason) {
    return {
      ok: false,
      reason: `Gemini blocked request: ${resp.promptFeedback.blockReason}`,
    };
  }
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  const fnPart = parts.find(
    (p): p is { functionCall: { name: string; args: unknown } } =>
      typeof (p as { functionCall?: unknown }).functionCall === 'object' &&
      (p as { functionCall: { name: string } }).functionCall?.name ===
        TOOL_NAME,
  );
  if (!fnPart) {
    const text = parts
      .map((p) => (p as { text?: string }).text ?? '')
      .filter(Boolean)
      .join('\n')
      .slice(0, 400);
    return {
      ok: false,
      reason: `Gemini did not call ${TOOL_NAME}${text ? ` (text: ${text})` : ''}`,
    };
  }
  const u = resp.usageMetadata ?? {};
  return finishProposal(fnPart.functionCall.args, 'google', model, {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
  });
}

async function listModels(apiKey: string): Promise<ModelDef[]> {
  const resp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    { headers: { 'x-goog-api-key': apiKey } },
  );
  if (!resp.ok) {
    throw new Error(
      `Gemini /v1beta/models returned HTTP ${resp.status}: ${(await resp
        .text()
        .catch(() => ''))
        .slice(0, 200)}`,
    );
  }
  const json = (await resp.json()) as {
    models?: {
      name: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
    }[];
  };
  const items = json.models ?? [];
  const out: ModelDef[] = [];
  for (const m of items) {
    if (typeof m.name !== 'string') continue;
    const methods = m.supportedGenerationMethods ?? [];
    if (!methods.includes('generateContent')) continue;
    // name comes as "models/gemini-2.5-pro" — strip the prefix.
    const id = m.name.replace(/^models\//, '');
    if (!id.startsWith('gemini-')) continue;
    out.push({ id, label: m.displayName?.trim() || prettifyId(id) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export const googleDriver: ProviderDriver = { propose, listModels };
