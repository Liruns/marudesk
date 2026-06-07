import { scrubText } from '../../shared/scrub';
import { S } from './loop-state';
import type { ToolContext, ToolResult } from './tools/types';
import { parseSubagentRequest, recordSubagentInput, SubagentInputError } from './subagent-request';
import { runChildAgent } from './subagent-runtime';
import type { SubagentRunRequest, SubagentRunner } from './subagent-types';

let testRunner: SubagentRunner | null = null;

export type { SubagentRunRequest, SubagentRunner } from './subagent-types';

export function setSubagentRunnerForTests(runner: SubagentRunner | null): void {
  testRunner = runner;
}

export async function runSubagentTool(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  let request: SubagentRunRequest;
  try {
    request = parseSubagentRequest(recordSubagentInput(input), ctx);
  } catch (err) {
    return inputErrorResult(err);
  }
  if (testRunner) return testRunner(request, ctx);
  // Roll child token spend into the parent conversation's cumulative totals so it
  // isn't invisible (audit H5). contextTokens is left untouched — it tracks the
  // PARENT's own last call (the context-window gauge + compaction trigger), which
  // the child's separate context must not perturb. The parent loop emit()s after
  // this tool returns, so no emit is needed here.
  return runChildAgent(request, ctx, ({ inputTokens, outputTokens }) => {
    S.state.usage.inputTokens += inputTokens;
    S.state.usage.outputTokens += outputTokens;
  });
}

function inputErrorResult(err: unknown): ToolResult {
  const message = err instanceof SubagentInputError || err instanceof Error ? err.message : String(err);
  return {
    summary: 'spawn_subagent failed',
    text: scrubText(message),
    isError: true,
  };
}
