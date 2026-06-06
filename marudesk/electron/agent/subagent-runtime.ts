import { streamText, type ModelMessage } from 'ai';
import { MODELS } from '../../shared/providers';
import { getSettingsSync } from '../settings';
import { CLAUDE_CODE_SYSTEM_PREFIX } from '../oauth/config';
import { buildEnvironmentContext } from './environment';
import { buildModel, aiTools, humanizeModelError } from './model';
import { callMcpTool, listMcpTools } from './mcp';
import { buildProviderOptions, maxTokensForTurn } from './reasoning-config';
import { resolveProviderAuth } from './resolve-auth';
import {
  ASK_USER,
  SPAWN_SUBAGENT,
  SPAWN_BACKGROUND_AGENT,
  COLLECT_BACKGROUND_AGENT,
  CANCEL_BACKGROUND_AGENT,
  type ToolContext,
  type ToolResult,
} from './tools/types';
import { childPrompt, subagentFailure, subagentSuccess, SUBAGENT_SYSTEM } from './subagent-format';
import type { ChildToolCall, ChildToolResultPart, SubagentRunRequest } from './subagent-types';

export async function runChildAgent(
  request: SubagentRunRequest,
  ctx: ToolContext,
): Promise<ToolResult> {
  const resolved = await resolveProviderAuth(request.provider);
  if (!resolved.ok) return subagentFailure(request, resolved.reason);

  const env = await buildEnvironmentContext(ctx.ws);
  const baseSystem =
    resolved.auth.mode === 'oauth' && request.provider === 'anthropic'
      ? `${CLAUDE_CODE_SYSTEM_PREFIX}\n\n${SUBAGENT_SYSTEM}`
      : SUBAGENT_SYSTEM;
  const system = `${baseSystem}\n\n---\n\n${env}`;
  const modelReasoning =
    MODELS.find((entry) => entry.provider === request.provider && entry.id === request.model)?.reasoning ??
    false;
  const effort = getSettingsSync().agent.reasoningEffort;
  const model = buildModel(request.provider, request.model, resolved.auth, resolved.baseUrl);
  const tools = aiTools(childToolDefs());
  const transcript: ModelMessage[] = [{ role: 'user', content: childPrompt(request, ctx) }];
  const childCtx: ToolContext = { ...ctx, provider: request.provider, model: request.model };
  const traces: string[] = [];
  let finalText = '';

  try {
    for (let step = 0; step < request.maxSteps; step += 1) {
      if (ctx.signal.aborted) return subagentFailure(request, 'aborted by user');
      const { text, calls, inputTokens, outputTokens } = await childStep({
        model,
        system,
        transcript,
        tools,
        request,
        modelReasoning,
        signal: ctx.signal,
        effort,
      });
      if (text.trim()) finalText = text.trim();
      if (inputTokens || outputTokens) {
        traces.push(`usage: ${inputTokens ?? 0} input / ${outputTokens ?? 0} output tokens`);
      }
      transcript.push({ role: 'assistant', content: assistantContent(text, calls) });
      if (calls.length === 0) {
        return subagentSuccess(request, finalText || '(child returned no text)', traces);
      }
      const toolResults: ChildToolResultPart[] = [];
      for (const call of calls) {
        const out = await callMcpTool(call.name, call.input, childCtx);
        traces.push(`${call.name}: ${out.summary}${out.isError ? ' (error)' : ''}`);
        toolResults.push(toolResult(call, out.text, out.isError));
      }
      transcript.push({ role: 'tool', content: toolResults });
    }
  } catch (err) {
    return subagentFailure(request, humanizeModelError(err, request.provider, request.model), traces);
  }

  return subagentFailure(
    request,
    `stopped at the child step limit (${request.maxSteps}) before a final report`,
    traces,
    finalText,
  );
}

function childToolDefs() {
  const excluded = new Set<string>([
    ASK_USER,
    SPAWN_SUBAGENT,
    SPAWN_BACKGROUND_AGENT,
    COLLECT_BACKGROUND_AGENT,
    CANCEL_BACKGROUND_AGENT,
  ]);
  return listMcpTools().filter(
    (tool) => !excluded.has(tool.name) && tool.write !== true && tool.gated !== true,
  );
}

async function childStep(params: {
  readonly model: ReturnType<typeof buildModel>;
  readonly system: string;
  readonly transcript: ModelMessage[];
  readonly tools: ReturnType<typeof aiTools>;
  readonly request: SubagentRunRequest;
  readonly modelReasoning: boolean;
  readonly signal: AbortSignal;
  readonly effort: ReturnType<typeof getSettingsSync>['agent']['reasoningEffort'];
}): Promise<{
  readonly text: string;
  readonly calls: readonly ChildToolCall[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}> {
  let text = '';
  const codexBackend = params.request.provider === 'openai-codex';
  const res = streamText({
    model: params.model,
    system: codexBackend ? undefined : params.system,
    messages: params.transcript,
    tools: params.tools,
    maxOutputTokens: codexBackend
      ? undefined
      : maxTokensForTurn(params.request.provider, params.modelReasoning, params.effort),
    providerOptions: buildProviderOptions(
      params.request.provider,
      params.system,
      params.modelReasoning,
      params.effort,
    ),
    abortSignal: params.signal,
  });
  for await (const part of res.fullStream) {
    if (part.type === 'text-delta') text += part.text;
  }
  const toolCalls = await res.toolCalls;
  const usage = await res.usage;
  return {
    text,
    calls: toolCalls.map((call) => ({
      id: call.toolCallId,
      name: call.toolName,
      input: call.input,
    })),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

function assistantContent(text: string, calls: readonly ChildToolCall[]) {
  return [
    ...(text.trim() ? [{ type: 'text' as const, text }] : []),
    ...calls.map((call) => ({
      type: 'tool-call' as const,
      toolCallId: call.id,
      toolName: call.name,
      input: call.input,
    })),
  ];
}

function toolResult(
  call: ChildToolCall,
  content: string,
  isError: boolean | undefined,
): ChildToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: call.id,
    toolName: call.name,
    output: isError
      ? { type: 'error-text', value: content }
      : { type: 'text', value: content },
  };
}
