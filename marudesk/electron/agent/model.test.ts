import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { buildModel } from './model.ts';

/**
 * buildModel routing/guard checks that need no real network. Constructing an AI
 * SDK model is synchronous; for the dialect-routed providers (github-copilot,
 * gitlab-duo) the request shape is what matters, so we either assert the guard
 * (gitlab-duo, whose fetch does a live token exchange) or mock fetch and assert
 * the endpoint the request actually hits (github-copilot).
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

// Minimal valid responses per dialect so generateText parses without throwing.
const anthropicBody = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'm',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const chatBody = {
  id: 'chatcmpl_test',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const responsesBody = {
  id: 'resp_test',
  object: 'response',
  status: 'completed',
  created_at: 1,
  model: 'm',
  output: [
    {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    },
  ],
  parallel_tool_calls: false,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

describe('buildModel — github-copilot dialect routing', () => {
  const calls: { url: string; headers: Headers }[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.includes('/messages')) return jsonResponse(anthropicBody);
      if (url.includes('/responses')) return jsonResponse(responsesBody);
      return jsonResponse(chatBody);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const oauth = { mode: 'oauth', accessToken: 'gho_test' } as const;
  async function lastCallFor(modelId: string) {
    await generateText({ model: buildModel('github-copilot', modelId, oauth), prompt: 'hi' });
    return calls[calls.length - 1];
  }

  it('routes Claude models to the anthropic-messages endpoint with an editor User-Agent', async () => {
    const call = await lastCallFor('claude-sonnet-4-6');
    expect(call.url).toBe('https://api.githubcopilot.com/v1/messages');
    expect(call.headers.get('user-agent')).toMatch(/Copilot/i);
    expect(call.headers.get('copilot-integration-id')).toBe('vscode-chat');
  });

  it('routes gpt-5 to the Responses API', async () => {
    const call = await lastCallFor('gpt-5');
    expect(call.url).toContain('https://api.githubcopilot.com/responses');
  });

  it('routes other models (gpt-4.1) to chat completions', async () => {
    const call = await lastCallFor('gpt-4.1');
    expect(call.url).toContain('https://api.githubcopilot.com/chat/completions');
  });

  it('requires an OAuth connection', () => {
    expect(() =>
      buildModel('github-copilot', 'gpt-4.1', { mode: 'api-key', apiKey: 'x' }),
    ).toThrow(/OAuth/i);
  });
});

describe('buildModel — subscription user-agent is forced past the SDK', () => {
  const calls: { url: string; headers: Headers }[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.includes('/messages')) return jsonResponse(anthropicBody);
      if (url.includes('/responses')) return jsonResponse(responsesBody);
      return jsonResponse(chatBody);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('Anthropic OAuth sends the claude-cli user-agent (not the SDK default)', async () => {
    await generateText({
      model: buildModel('anthropic', 'claude-sonnet-4-6', { mode: 'oauth', accessToken: 'tok' }),
      prompt: 'hi',
    });
    const ua = calls[calls.length - 1]?.headers.get('user-agent') ?? '';
    expect(ua).toMatch(/claude-cli/);
    expect(ua).not.toMatch(/^ai\//);
  });

  it('Codex sends the codex_cli_rs user-agent + originator (dodges Cloudflare 403)', async () => {
    await generateText({
      model: buildModel('openai-codex', 'gpt-5-codex', { mode: 'oauth', accessToken: 'tok' }),
      prompt: 'hi',
    });
    const last = calls[calls.length - 1];
    expect(last?.headers.get('user-agent')).toMatch(/codex_cli_rs/);
    expect(last?.headers.get('originator')).toBe('codex_cli_rs');
  });
});

describe('buildModel — gitlab-duo', () => {
  // No network here: only buildModel is called (the PAT→token exchange fires
  // lazily inside the per-request fetch, which these never invoke).
  const key = { mode: 'api-key', apiKey: 'glpat-test' } as const;

  it('builds a Claude model (anthropic-dialect proxy) without throwing', () => {
    expect(() => buildModel('gitlab-duo', 'claude-sonnet-4-6', key)).not.toThrow();
  });

  it('builds a GPT model (openai-dialect proxy) without throwing', () => {
    expect(() => buildModel('gitlab-duo', 'gpt-5', key)).not.toThrow();
  });

  it('requires a PAT — rejects an OAuth auth mode', () => {
    expect(() =>
      buildModel('gitlab-duo', 'claude-sonnet-4-6', { mode: 'oauth', accessToken: 't' }),
    ).toThrow(/GitLab access token/i);
  });

  it('requires a non-empty key', () => {
    expect(() => buildModel('gitlab-duo', 'gpt-5', { mode: 'api-key', apiKey: '' })).toThrow(
      /GitLab access token/i,
    );
  });
});
