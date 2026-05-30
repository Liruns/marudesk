import type { ProposeResult, ProposeUsage } from '../../shared/composer';
import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import {
  MAX_TOKENS,
  SYSTEM_PROMPT,
  TOOL_INPUT_SCHEMA,
  TOOL_NAME,
  finishProposal,
  prettifyId,
} from './tool';

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

type AnthropicResponse = {
  id: string;
  model: string;
  stop_reason: string | null;
  content: AnthropicContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

async function propose(
  apiKey: string,
  model: string,
  userText: string,
): Promise<ProposeResult> {
  let resp: AnthropicResponse;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    resp = (await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [
        {
          name: TOOL_NAME,
          description:
            'Emit a minimal sequence of string-replace edits to fulfill the user request.',
          input_schema: TOOL_INPUT_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: userText }],
    } as unknown as Parameters<typeof client.messages.create>[0])) as unknown as AnthropicResponse;
  } catch (err) {
    return {
      ok: false,
      reason: `Anthropic API call failed: ${(err as Error).message}`,
    };
  }

  const toolBlock = resp.content.find(
    (b): b is AnthropicToolUseBlock =>
      b.type === 'tool_use' && b.name === TOOL_NAME,
  );
  if (!toolBlock) {
    const text = resp.content
      .filter((b): b is AnthropicTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .slice(0, 400);
    return {
      ok: false,
      reason: `model did not call ${TOOL_NAME}${text ? ` (text: ${text})` : ''}`,
    };
  }
  const u = resp.usage ?? {};
  const usage: ProposeUsage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens,
    cacheCreationTokens: u.cache_creation_input_tokens,
  };
  return finishProposal(toolBlock.input, 'anthropic', model, usage);
}

async function listModels(apiKey: string): Promise<ModelDef[]> {
  const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!resp.ok) {
    throw new Error(
      `Anthropic /v1/models returned HTTP ${resp.status}: ${(await resp
        .text()
        .catch(() => ''))
        .slice(0, 200)}`,
    );
  }
  const json = (await resp.json()) as {
    data?: { id: string; display_name?: string }[];
  };
  const items = json.data ?? [];
  return items
    .filter((m) => typeof m.id === 'string')
    .map((m) => ({
      id: m.id,
      label: m.display_name?.trim() || prettifyId(m.id),
    }));
}

export const anthropicDriver: ProviderDriver = { propose, listModels };
