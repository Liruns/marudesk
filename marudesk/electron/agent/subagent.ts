import { scrubText } from '../../shared/scrub';
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
  return runChildAgent(request, ctx);
}

function inputErrorResult(err: unknown): ToolResult {
  const message = err instanceof SubagentInputError || err instanceof Error ? err.message : String(err);
  return {
    summary: 'spawn_subagent failed',
    text: scrubText(message),
    isError: true,
  };
}
