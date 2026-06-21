import { scrubText } from '../../shared/scrub';
import type { ToolContext, ToolResult } from './tools/types';
import { SAFETY_FOOTER } from './prompts';
import { MAX_CHILD_RESULT_CHARS, type SubagentRunRequest } from './subagent-types';

export const SUBAGENT_SYSTEM = `You are a marudesk child agent spawned by the parent AI Chat agent.

Work only on the delegated task. Be concise, evidence-driven, and return a final report the parent can use.

You may inspect the workspace and live app with read-only tools. You cannot edit files, run gated browser/PC actions, ask the user, or spawn another subagent. If the task requires those actions, explain exactly what the parent should do next.

${SAFETY_FOOTER}`;

export function childPrompt(request: SubagentRunRequest, ctx: ToolContext): string {
  const workspace = ctx.ws
    ? `Workspace: ${ctx.ws.name} (${ctx.ws.files.length} indexed files).`
    : 'Workspace: none open; file tools are unavailable.';
  const tab = ctx.tabId ? `Active web tab id: ${ctx.tabId}.` : 'Active web tab: none.';
  const role = request.agent ? `Role: ${request.agent.name} — ${request.agent.description}\n` : '';
  return `${workspace}\n${tab}\n${role}\nDelegated task:\n${request.task}\n\nReturn a compact final report for the parent agent.`;
}

export function subagentSuccess(
  request: SubagentRunRequest,
  result: string,
  traces: readonly string[],
  continuationId?: string,
): ToolResult {
  return {
    summary: subagentSummary(request),
    text: formatSubagentResult(request, 'completed', result, traces, continuationId),
  };
}

export function subagentFailure(
  request: SubagentRunRequest,
  error: string,
  traces: readonly string[] = [],
  partial = '',
  continuationId?: string,
): ToolResult {
  const detail = partial.trim()
    ? `${partial.trim()}\n\nError: ${error}`
    : `Error: ${error}`;
  return {
    summary: `${subagentSummary(request)} failed`,
    text: formatSubagentResult(request, 'failed', detail, traces, continuationId),
    isError: true,
  };
}

function subagentSummary(request: SubagentRunRequest): string {
  const role = request.agent ? ` (${request.agent.name})` : '';
  return `Subagent ${request.label}${role} - ${request.provider}/${request.model}`;
}

function formatSubagentResult(
  request: SubagentRunRequest,
  status: 'completed' | 'failed',
  body: string,
  traces: readonly string[],
  continuationId?: string,
): string {
  const traceText = traces.length > 0 ? `\n\nTool trace:\n${traces.map((trace) => `- ${trace}`).join('\n')}` : '';
  // Surface the continuation id so the parent can RESUME this child (item:
  // sub-session continuation) by passing `resume: <id>` to a follow-up
  // spawn_subagent — seeding the child from this transcript instead of cold.
  const contText = continuationId
    ? `\n\nContinuation id: ${continuationId} (pass as spawn_subagent \`resume\` to continue this session without re-exploring).`
    : '';
  const text = [
    `Task: ${request.task}`,
    ...(request.agent ? [`Agent: ${request.agent.name}`] : []),
    `Provider/model: ${request.provider} / ${request.model}`,
    `Status: ${status}`,
    '',
    'Result:',
    body,
  ].join('\n');
  const scrubbed = scrubText(`${text}${traceText}${contText}`);
  return scrubbed.length <= MAX_CHILD_RESULT_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, MAX_CHILD_RESULT_CHARS)}\n...[subagent output clipped]`;
}
