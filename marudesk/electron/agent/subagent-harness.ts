import assert from 'node:assert/strict';
import { listMcpTools } from './mcp.ts';
import {
  runSubagentTool,
  setSubagentRunnerForTests,
  type SubagentRunRequest,
} from './subagent.ts';
import type { ToolContext } from './tools/types.ts';

let passed = 0;

function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

const listed = listMcpTools();
check('spawn_subagent is listed for the model', listed.some((tool) => tool.name === 'spawn_subagent'));
check(
  'spawn_subagent requires per-call approval',
  listed.find((tool) => tool.name === 'spawn_subagent')?.gated === true,
);

const ctx: ToolContext = {
  ws: null,
  signal: new AbortController().signal,
  provider: 'ollama',
  model: 'qwen2.5-coder',
};
const capturedRequests: SubagentRunRequest[] = [];
setSubagentRunnerForTests(async (request) => {
  capturedRequests.push(request);
  return {
    summary: `Subagent ${request.label} · ${request.provider}/${request.model}`,
    text: `Task: ${request.task}\nProvider/model: ${request.provider} / ${request.model}\nStatus: completed\n\nResult:\nchild report ok`,
  };
});

const out = await runSubagentTool({ task: 'inspect spawn plumbing', label: 'Researcher' }, ctx);
const capturedRequest = capturedRequests[0];
check('spawn_subagent test runner executes', out.text.includes('child report ok'));
check('spawn_subagent falls back to parent provider', capturedRequest?.provider === 'ollama');
check('spawn_subagent falls back to parent model', capturedRequest?.model === 'qwen2.5-coder');
check('spawn_subagent forwards the bounded task', capturedRequest?.task === 'inspect spawn plumbing');

const badProvider = await runSubagentTool({ task: 'x', provider: 'not-a-provider' }, ctx);
check('spawn_subagent rejects unknown providers', badProvider.isError === true);
check('spawn_subagent reports invalid provider text', badProvider.text.includes('unknown provider'));

capturedRequests.length = 0;
setSubagentRunnerForTests(async (request) => {
  capturedRequests.push(request);
  return { summary: 'ok', text: 'child report ok' };
});
const defaulted = await runSubagentTool({ task: 'y', provider: 'default', model: 'default' }, ctx);
check('spawn_subagent treats "default" provider as inherit', defaulted.isError !== true);
check('"default" provider inherits the parent provider', capturedRequests[0]?.provider === 'ollama');
check('"default" model inherits the parent model', capturedRequests[0]?.model === 'qwen2.5-coder');
setSubagentRunnerForTests(null);

console.log(`\nsubagent harness: ${passed} assertions passed`);
