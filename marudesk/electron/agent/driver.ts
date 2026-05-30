import type { ProviderId } from '../../shared/providers';
import type { ToolSchema } from './tools';

/**
 * Provider-agnostic single-step execution for the agent loop (loop.ts drives the
 * multi-step loop manually — stagewise's `stopWhen: () => true` pattern). A driver
 * does exactly one model round-trip: given the running transcript + tools, return
 * the assistant's text, any tool calls, and usage. The loop executes the tools,
 * appends results, and re-enters. Anthropic first; OpenAI/Gemini/Ollama (P3) are
 * added by registering another {@link AgentDriver} — no loop changes.
 */

/** Neutral transcript content; each driver maps it to its provider's blocks. */
export type LoopContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export type LoopMessage = { role: 'user' | 'assistant'; content: LoopContent[] };

export type StepResult = {
  text: string;
  toolUses: { id: string; name: string; input: unknown }[];
  usage: { inputTokens: number; outputTokens: number };
};

export type StepOptions = {
  apiKey: string;
  model: string;
  system: string;
  messages: LoopMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
};

export interface AgentDriver {
  step(opts: StepOptions): Promise<StepResult>;
}

const AGENT_MAX_TOKENS = 4_096;

/* ── Anthropic ──────────────────────────────────────────────────────────── */

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

function toAnthropicMessages(messages: LoopMessage[]): { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((c): AnthropicBlock => {
      if (c.type === 'text') return { type: 'text', text: c.text };
      if (c.type === 'tool_use') return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
      return { type: 'tool_result', tool_use_id: c.toolUseId, content: c.content, is_error: c.isError };
    }),
  }));
}

const anthropicDriver: AgentDriver = {
  async step(opts) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: opts.apiKey });
    const resp = (await client.messages.create(
      {
        model: opts.model,
        max_tokens: AGENT_MAX_TOKENS,
        system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
        tools: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        messages: toAnthropicMessages(opts.messages),
      } as unknown as Parameters<typeof client.messages.create>[0],
      { signal: opts.signal },
    )) as unknown as {
      content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    let text = '';
    const toolUses: StepResult['toolUses'] = [];
    for (const block of resp.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      else if (block.type === 'tool_use' && block.id && block.name) {
        toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    }
    return {
      text,
      toolUses,
      usage: {
        inputTokens: resp.usage?.input_tokens ?? 0,
        outputTokens: resp.usage?.output_tokens ?? 0,
      },
    };
  },
};

/* ── OpenAI-compatible (OpenAI + Ollama) ────────────────────────────────── */

type OAToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
type OAResponse = {
  choices?: { message?: { content?: string | null; tool_calls?: OAToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** Flatten the neutral transcript into OpenAI chat messages (tool_results become `role:'tool'`). */
function toOpenAIMessages(system: string, messages: LoopMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
      const toolCalls = m.content
        .filter((c) => c.type === 'tool_use')
        .map((c) => {
          const t = c as { id: string; name: string; input: unknown };
          return { id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } };
        });
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // A user turn is either typed text or a batch of tool_results.
      const results = m.content.filter((c) => c.type === 'tool_result');
      if (results.length > 0) {
        for (const c of results) {
          const r = c as { toolUseId: string; content: string };
          out.push({ role: 'tool', tool_call_id: r.toolUseId, content: r.content });
        }
      } else {
        const text = m.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
        out.push({ role: 'user', content: text });
      }
    }
  }
  return out;
}

function makeOpenAICompatDriver(opts: {
  baseUrl: string;
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  auth: boolean;
  label: string;
}): AgentDriver {
  return {
    async step(stepOpts) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.auth && stepOpts.apiKey) headers.Authorization = `Bearer ${stepOpts.apiKey}`;
      const resp = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal: stepOpts.signal,
        body: JSON.stringify({
          model: stepOpts.model,
          [opts.tokenParam]: AGENT_MAX_TOKENS,
          messages: toOpenAIMessages(stepOpts.system, stepOpts.messages),
          tools: stepOpts.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          tool_choice: 'auto',
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`${opts.label} HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }
      const json = (await resp.json()) as OAResponse;
      const msg = json.choices?.[0]?.message;
      const toolUses: StepResult['toolUses'] = [];
      for (const c of msg?.tool_calls ?? []) {
        if (!c.function?.name) continue;
        let input: unknown;
        try {
          input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          input = {};
        }
        toolUses.push({ id: c.id || `call-${toolUses.length}`, name: c.function.name, input });
      }
      return {
        text: typeof msg?.content === 'string' ? msg.content : '',
        toolUses,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

/* ── registry ───────────────────────────────────────────────────────────── */

const AGENT_DRIVERS: Partial<Record<ProviderId, AgentDriver>> = {
  anthropic: anthropicDriver,
  openai: makeOpenAICompatDriver({
    baseUrl: 'https://api.openai.com/v1',
    tokenParam: 'max_completion_tokens',
    auth: true,
    label: 'OpenAI',
  }),
  ollama: makeOpenAICompatDriver({
    baseUrl: 'http://localhost:11434/v1',
    tokenParam: 'max_tokens',
    auth: false,
    label: 'Ollama',
  }),
};

export function getAgentDriver(provider: ProviderId): AgentDriver | null {
  return AGENT_DRIVERS[provider] ?? null;
}
