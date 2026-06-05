import { scrubText } from '../../shared/scrub';
import type { ToolContext, ToolResult } from './tools/types';
import { MAX_CHILD_RESULT_CHARS, type SubagentRunRequest } from './subagent-types';

export const SUBAGENT_SYSTEM = `You are a marudesk child agent spawned by the parent AI Chat agent.

Work only on the delegated task. Be concise, evidence-driven, and return a final report the parent can use.

You may inspect the workspace and live app with read-only tools. You cannot edit files, run gated browser/PC actions, ask the user, or spawn another subagent. If the task requires those actions, explain exactly what the parent should do next.`;

export function childPrompt(request: SubagentRunRequest, ctx: ToolContext): string {
  const workspace = ctx.ws
    ? `Workspace: ${ctx.ws.name} (${ctx.ws.files.length} indexed files).`
    : 'Workspace: none open; file tools are unavailable.';
  const tab = ctx.tabId ? `Active web tab id: ${ctx.tabId}.` : 'Active web tab: none.';
  return `${workspace}\n${tab}\n\nDelegated task:\n${request.task}\n\nReturn a compact final report for the parent agent.`;
}

export function subagentSuccess(
  request: SubagentRunRequest,
  result: string,
  traces: readonly string[],
): ToolResult {
  return {
    summary: subagentSummary(request),
    text: formatSubagentResult(request, 'completed', result, traces),
  };
}

export function subagentFailure(
  request: SubagentRunRequest,
  error: string,
  traces: readonly string[] = [],
  partial = '',
): ToolResult {
  const detail = partial.trim()
    ? `${partial.trim()}\n\nError: ${error}`
    : `Error: ${error}`;
  return {
    summary: `${subagentSummary(request)} failed`,
    text: formatSubagentResult(request, 'failed', detail, traces),
    isError: true,
  };
}

function subagentSummary(request: SubagentRunRequest): string {
  return `Subagent ${request.label} - ${request.provider}/${request.model}`;
}

function formatSubagentResult(
  request: SubagentRunRequest,
  status: 'completed' | 'failed',
  body: string,
  traces: readonly string[],
): string {
  const traceText = traces.length > 0 ? `\n\nTool trace:\n${traces.map((trace) => `- ${trace}`).join('\n')}` : '';
  const text = [
    `Task: ${request.task}`,
    `Provider/model: ${request.provider} / ${request.model}`,
    `Status: ${status}`,
    '',
    'Result:',
    body,
  ].join('\n');
  const scrubbed = scrubText(`${text}${traceText}`);
  return scrubbed.length <= MAX_CHILD_RESULT_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, MAX_CHILD_RESULT_CHARS)}\n...[subagent output clipped]`;
}
