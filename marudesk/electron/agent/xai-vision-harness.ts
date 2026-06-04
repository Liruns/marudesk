import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { buildModel } from './model';
import { buildProviderOptions } from './reasoning-config';

type CapturedRequest = {
  readonly url: string;
  readonly body: unknown;
};

const captured: { current: CapturedRequest | null } = { current: null };
const originalFetch = globalThis.fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function responseFor(url: string): Response {
  if (url.includes('/responses')) {
    return Response.json({
      id: 'resp_test',
      object: 'response',
      status: 'completed',
      created_at: 1,
      model: 'grok-4.3',
      output: [
        {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ok', annotations: [], logprobs: [] }],
        },
      ],
      parallel_tool_calls: true,
      previous_response_id: null,
      temperature: 0.7,
      text: { format: { type: 'text' } },
      tool_choice: 'auto',
      tools: [],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { text_tokens: 1, image_tokens: 0, cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  }

  return Response.json({
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 1,
    model: 'grok-4.3',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

globalThis.fetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const url = input instanceof Request ? input.url : input.toString();
  const rawBody = typeof init?.body === 'string' ? init.body : '{}';
  captured.current = { url, body: JSON.parse(rawBody) as unknown };
  return responseFor(url);
};

try {
  await generateText({
    model: buildModel('xai', 'grok-4.3', { mode: 'api-key', apiKey: 'xai-test' }),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', image: 'iVBORw0KGgo=', mediaType: 'image/png' },
        ],
      },
    ],
    providerOptions: buildProviderOptions('xai', 'system', true, 'medium'),
  });
} finally {
  globalThis.fetch = originalFetch;
}

const request = captured.current;
assert.ok(request, 'xAI request was captured');
assert.ok(request.url.endsWith('/responses'), `xAI vision should use Responses API, got ${request.url}`);
assert.ok(isRecord(request.body), 'xAI request body is an object');
const input = request.body.input;
assert.ok(Array.isArray(input), 'Responses body contains input array');
const first = input[0];
assert.ok(isRecord(first), 'first input item is an object');
const content = first.content;
assert.ok(Array.isArray(content), 'first input item contains content parts');
assert.ok(
  content.some((part) => isRecord(part) && part.type === 'input_image' && typeof part.image_url === 'string'),
  'Responses body contains an input_image part',
);
assert.equal(request.body.store, false, 'xAI agent turns should not be stored remotely');

console.log('xAI vision payload harness passed');
