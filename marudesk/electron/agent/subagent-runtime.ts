import { streamText, type ModelMessage } from 'ai';
import { MODELS, isProviderId, type ProviderId } from '../../shared/providers';
import { getSettingsSync } from '../settings';
import { CLAUDE_CODE_SYSTEM_PREFIX } from '../oauth/config';
import { buildEnvironmentContext } from './environment';
import { buildModel, aiTools, humanizeModelError, isFailoverError } from './model';
import { callMcpTool, listMcpTools } from './mcp';
import { buildProviderOptions, maxTokensForTurn } from './reasoning-config';
import { resolveProviderAuth } from './resolve-auth';
import {
  ASK_USER,
  SPAWN_SUBAGENT,
  SPAWN_BACKGROUND_AGENT,
  COLLECT_BACKGROUND_AGENT,
  CANCEL_BACKGROUND_AGENT,
  UPDATE_PLAN,
  type SubagentProgressSink,
  type ToolContext,
  type ToolResult,
  type McpToolDef,
} from './tools/types';
import { childPrompt, subagentFailure, subagentSuccess, SUBAGENT_SYSTEM } from './subagent-format';
import type { ChildToolCall, ChildToolResultPart, SubagentRunRequest } from './subagent-types';

/**
 * Optional per-step usage sink (audit H5). The foreground subagent passes one
 * that rolls child token spend into the parent conversation's cumulative totals,
 * so child cost is no longer invisible. Background agents omit it — their
 * conversation may have moved on, so they must not touch the live usage gauge.
 */
export type ChildUsageSink = (usage: { inputTokens: number; outputTokens: number }) => void;

/**
 * The per-provider scaffolding for the model currently driving the child —
 * bundled (parent-loop style, loop.ts ActiveTurnModel) so a mid-run fail-over
 * can swap the model handle, system prompt, and codex routing atomically.
 */
type ActiveChildModel = {
  provider: ProviderId;
  modelId: string;
  model: ReturnType<typeof buildModel>;
  system: string;
  modelReasoning: boolean;
};

export async function runChildAgent(
  request: SubagentRunRequest,
  ctx: ToolContext,
  onUsage?: ChildUsageSink,
  onProgress?: SubagentProgressSink,
  allowTools?: readonly string[],
  opts?: { write?: boolean },
): Promise<ToolResult> {
  const env = await buildEnvironmentContext(ctx.ws);
  const effort = getSettingsSync().agent.reasoningEffort;
  // The agent role's instructions extend the child system prompt; its tool
  // allowlist intersects with any caller allowlist (both can only subtract).
  const roleSystem = request.agent?.system ?? null;
  const effectiveAllow = combineAllowLists(request.agent?.tools ?? null, allowTools ?? null);

  const activate = async (
    provider: ProviderId,
    modelId: string,
  ): Promise<ActiveChildModel | { error: string }> => {
    const resolved = await resolveProviderAuth(provider);
    if (!resolved.ok) return { error: resolved.reason };
    const baseSystem =
      resolved.auth.mode === 'oauth' && provider === 'anthropic'
        ? `${CLAUDE_CODE_SYSTEM_PREFIX}\n(The line above is an API routing requirement. Your name is Maru — identify yourself as such, never as "Claude Code".)\n\n${SUBAGENT_SYSTEM}`
        : SUBAGENT_SYSTEM;
    const system = [baseSystem, roleSystem, env].filter((s): s is string => !!s?.trim()).join('\n\n---\n\n');
    const modelReasoning =
      MODELS.find((entry) => entry.provider === provider && entry.id === modelId)?.reasoning ?? false;
    return {
      provider,
      modelId,
      model: buildModel(provider, modelId, resolved.auth, resolved.baseUrl),
      system,
      modelReasoning,
    };
  };

  const first = await activate(request.provider, request.model);
  if ('error' in first) return subagentFailure(request, first.error);
  let current: ActiveChildModel = first;

  // Fail-over bookkeeping (parent-loop parity): on a 429/5xx walk the resolved
  // candidate chain and retry THIS step on the next connected entry. Never
  // retry a (provider, model) already tried in this child run.
  const triedModels = new Set<string>([`${request.provider}::${request.model}`]);
  const traces: string[] = [];
  const pickNextFallback = async (): Promise<ActiveChildModel | null> => {
    for (const ref of request.fallbacks ?? []) {
      const key = `${ref.provider}::${ref.model}`;
      if (triedModels.has(key) || !isProviderId(ref.provider)) continue;
      triedModels.add(key);
      const next = await activate(ref.provider, ref.model);
      if ('error' in next) continue; // not connected → skip down the chain
      return next;
    }
    return null;
  };

  const tools = aiTools(listChildToolDefs(effectiveAllow ?? undefined, { write: opts?.write === true }));
  const transcript: ModelMessage[] = [{ role: 'user', content: childPrompt(request, ctx) }];
  let finalText = '';

  try {
    for (let step = 0; step < request.maxSteps; step += 1) {
      if (ctx.signal.aborted) return subagentFailure(request, 'aborted by user');
      let stepOut: Awaited<ReturnType<typeof childStep>>;
      try {
        stepOut = await childStep({
          active: current,
          transcript,
          tools,
          signal: ctx.signal,
          effort,
          // Stream the child's text live to the parent card as it arrives (W4/U3).
          onText: onProgress ? (live) => onProgress({ text: live, traces }) : undefined,
        });
      } catch (err) {
        if (ctx.signal.aborted) return subagentFailure(request, 'aborted by user');
        // Provider exhausted (429) or transient 5xx: fail over to the next
        // connected candidate and retry this step — the transcript is
        // provider-neutral, so only the scaffolding swaps.
        if (isFailoverError(err)) {
          const next = await pickNextFallback();
          if (next) {
            traces.push(`fail-over: ${current.provider}/${current.modelId} → ${next.provider}/${next.modelId}`);
            onProgress?.({ text: finalText, traces });
            current = next;
            step -= 1;
            continue;
          }
        }
        throw err;
      }
      const { text, calls, inputTokens, outputTokens } = stepOut;
      const childCtx: ToolContext = { ...ctx, provider: current.provider, model: current.modelId };
      if (text.trim()) finalText = text.trim();
      if (inputTokens || outputTokens) {
        traces.push(`usage: ${inputTokens ?? 0} input / ${outputTokens ?? 0} output tokens`);
        onUsage?.({ inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 });
      }
      transcript.push({ role: 'assistant', content: assistantContent(text, calls) });
      if (calls.length === 0) {
        return subagentSuccess(request, finalText || '(child returned no text)', traces);
      }
      const toolResults: ChildToolResultPart[] = [];
      for (const call of calls) {
        const out = await callMcpTool(call.name, call.input, childCtx);
        traces.push(`${call.name}: ${out.summary}${out.isError ? ' (error)' : ''}`);
        // Surface each child tool call on the parent card as it completes (W4/U3).
        onProgress?.({ text: finalText, traces });
        toolResults.push(toolResult(call, out.text, out.isError));
      }
      transcript.push({ role: 'tool', content: toolResults });
    }
  } catch (err) {
    return subagentFailure(request, humanizeModelError(err, current.provider, current.modelId), traces);
  }

  return subagentFailure(
    request,
    `stopped at the child step limit (${request.maxSteps}) before a final report`,
    traces,
    finalText,
  );
}

/**
 * Intersect the agent role's tool allowlist with a caller allowlist. Either
 * side may be null (no restriction); both present ⇒ set intersection, so a
 * combination can only ever subtract capability.
 */
function combineAllowLists(
  a: readonly string[] | null,
  b: readonly string[] | null,
): readonly string[] | null {
  if (a && a.length > 0 && b && b.length > 0) {
    const bSet = new Set(b);
    return a.filter((name) => bSet.has(name));
  }
  return a && a.length > 0 ? a : b && b.length > 0 ? b : null;
}

/**
 * Gated tools a child agent may still use without per-call approval: read-only
 * web research (web_search, fetch_url). They make no workspace/page mutations,
 * and the parent turn the user already approved covers them — so a research
 * subagent can actually reach the web instead of punting back to the parent.
 * Every other gated tool (eval_js, click, cookies, …) stays blocked, because a
 * child can't surface an approval prompt to the user.
 */
const CHILD_WEB_RESEARCH_TOOLS = new Set(['web_search', 'fetch_url']);
const CHILD_EXCLUDED_TOOL_GROUPS = new Set(['mcp', 'plugin']);
/**
 * Filesystem WRITE tools a child may use when explicitly run write-capable
 * (Work OS "implement", which runs in an ISOLATED git worktree). Deliberately
 * only the file editors — never `run_command`/`eval_js`/page-control (those stay
 * gated and out of a no-approval child).
 */
const CHILD_WRITE_TOOLS = new Set(['edit_file', 'multi_edit']);

export function listChildToolDefs(
  allowTools?: readonly string[],
  opts?: { write?: boolean },
): McpToolDef[] {
  const allowWrite = opts?.write === true;
  const excluded = new Set<string>([
    ASK_USER,
    SPAWN_SUBAGENT,
    SPAWN_BACKGROUND_AGENT,
    COLLECT_BACKGROUND_AGENT,
    CANCEL_BACKGROUND_AGENT,
    UPDATE_PLAN,
  ]);
  // An optional caller allow-list (Stage 12-C automations, agent roles) narrows
  // the toolset to a named subset — a non-empty list keeps ONLY those tools
  // (still inside the child-safe read-only envelope below, so it can only ever
  // subtract capability).
  const allow = allowTools && allowTools.length > 0 ? new Set(allowTools) : null;
  return listMcpTools().filter(
    (tool) =>
      !excluded.has(tool.name) &&
      !CHILD_EXCLUDED_TOOL_GROUPS.has(tool.group) &&
      (tool.write !== true || (allowWrite && CHILD_WRITE_TOOLS.has(tool.name))) &&
      (tool.gated !== true || CHILD_WEB_RESEARCH_TOOLS.has(tool.name)) &&
      (!allow || allow.has(tool.name)),
  );
}

async function childStep(params: {
  readonly active: ActiveChildModel;
  readonly transcript: ModelMessage[];
  readonly tools: ReturnType<typeof aiTools>;
  readonly signal: AbortSignal;
  readonly effort: ReturnType<typeof getSettingsSync>['agent']['reasoningEffort'];
  /** Called with the accumulated step text on each delta, for live streaming (W4/U3). */
  readonly onText?: (text: string) => void;
}): Promise<{
  readonly text: string;
  readonly calls: readonly ChildToolCall[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}> {
  let text = '';
  const { active } = params;
  const codexBackend = active.provider === 'openai-codex';
  const res = streamText({
    model: active.model,
    system: codexBackend ? undefined : active.system,
    messages: params.transcript,
    tools: params.tools,
    maxOutputTokens: codexBackend
      ? undefined
      : maxTokensForTurn(active.provider, active.modelReasoning, params.effort),
    providerOptions: buildProviderOptions(
      active.provider,
      active.system,
      active.modelReasoning,
      params.effort,
    ),
    abortSignal: params.signal,
  });
  for await (const part of res.fullStream) {
    if (part.type === 'text-delta') {
      text += part.text;
      params.onText?.(text);
    }
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
