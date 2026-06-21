import { check, passedCount } from '../harness-kit';
import { listMcpTools, registerMcpServer, unregisterMcpServer } from './mcp.ts';
import {
  listChildToolDefs,
  runSubagentTool,
  setSubagentRunnerForTests,
  type SubagentRunRequest,
} from './subagent.ts';
import { DEFAULT_CHILD_STEPS, MAX_CHILD_STEPS } from './subagent-types.ts';
import { SUBAGENT_SYSTEM } from './subagent-format.ts';
import { SAFETY_FOOTER } from './prompts.ts';
import type { ToolContext } from './tools/types.ts';

const listed = listMcpTools();
check('spawn_subagent is listed for the model', listed.some((tool) => tool.name === 'spawn_subagent'));
check(
  'spawn_subagent requires per-call approval',
  listed.find((tool) => tool.name === 'spawn_subagent')?.gated === true,
);
// The child reads untrusted workspace files, web pages, and tool output, then
// feeds a free-text report back into the parent transcript — so it must carry
// the same precedence / data-not-commands pin the parent does (SAFETY_FOOTER).
check('child system prompt carries the precedence/data-not-commands pin', SUBAGENT_SYSTEM.includes(SAFETY_FOOTER));

const childToolNames = new Set(listChildToolDefs().map((tool) => tool.name));
check('child toolset excludes ask_user', !childToolNames.has('ask_user'));
check('child toolset excludes nested spawn_subagent', !childToolNames.has('spawn_subagent'));
check('child toolset excludes detached background spawns', !childToolNames.has('spawn_background_agent'));
check('child toolset excludes background collection', !childToolNames.has('collect_background_agent'));
check('child toolset excludes background cancellation', !childToolNames.has('cancel_background_agent'));
check('child toolset excludes update_plan', !childToolNames.has('update_plan'));
check('child toolset exposes no write tools', listChildToolDefs().every((tool) => tool.write !== true));
check(
  'child toolset exposes no gated tools except read-only web research',
  listChildToolDefs().every((tool) => tool.gated !== true || ['web_search', 'fetch_url'].includes(tool.name)),
);

registerMcpServer({
  name: 'child-test-external',
  tools: [
    {
      name: 'child_external__trusted',
      description: 'trusted external tool with no write annotation',
      group: 'mcp',
      gated: false,
      write: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      exec: async () => ({ summary: 'ok', text: 'ok' }),
    },
    {
      name: 'plugin:child-test__trusted',
      description: 'trusted plugin tool with no write annotation',
      group: 'plugin',
      gated: false,
      write: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      exec: async () => ({ summary: 'ok', text: 'ok' }),
    },
  ],
});
const childToolNamesWithExternal = new Set(listChildToolDefs().map((tool) => tool.name));
check('child toolset excludes trusted external MCP tools', !childToolNamesWithExternal.has('child_external__trusted'));
check('child toolset excludes trusted plugin tools', !childToolNamesWithExternal.has('plugin:child-test__trusted'));
unregisterMcpServer('child-test-external');

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
check('spawn_subagent uses the default child step cap', capturedRequest?.maxSteps === DEFAULT_CHILD_STEPS);

const badProvider = await runSubagentTool({ task: 'x', provider: 'not-a-provider' }, ctx);
check('spawn_subagent rejects unknown providers', badProvider.isError === true);
check('spawn_subagent reports invalid provider text', badProvider.text.includes('unknown provider'));

// Agent roles: list_agents is exposed read-only; spawn resolves a role into the
// request (system/tool/model preferences ride along on request.agent).
check('list_agents is listed for the model', listed.some((tool) => tool.name === 'list_agents'));
check(
  'list_agents is read-only and non-gated',
  listed.find((tool) => tool.name === 'list_agents')?.gated !== true &&
    listed.find((tool) => tool.name === 'list_agents')?.write !== true,
);
capturedRequests.length = 0;
setSubagentRunnerForTests(async (request) => {
  capturedRequests.push(request);
  return { summary: 'ok', text: 'child report ok' };
});
const roled = await runSubagentTool({ task: 'find the loop entry', agent: 'explore' }, ctx);
check('spawn_subagent accepts a built-in agent role', roled.isError !== true);
check('the agent role rides on the request', capturedRequests[0]?.agent?.name === 'explore');
check(
  'the explore role narrows the child toolset',
  (capturedRequests[0]?.agent?.tools ?? []).includes('grep') === true,
);
const badAgent = await runSubagentTool({ task: 'x', agent: 'no-such-role' }, ctx);
check('spawn_subagent rejects an unknown agent role', badAgent.isError === true);
check('the unknown-agent error lists available roles', badAgent.text.includes('explore'));

// Tier sentinels: model "fast"/"smart" resolve through the provider chain
// instead of being treated as literal model ids.
capturedRequests.length = 0;
const tiered = await runSubagentTool({ task: 'y', model: 'fast' }, ctx);
check('spawn_subagent accepts the "fast" tier sentinel', tiered.isError !== true);
check('a tier sentinel never reaches the child as a literal model id', capturedRequests[0]?.model !== 'fast');

capturedRequests.length = 0;
setSubagentRunnerForTests(async (request) => {
  capturedRequests.push(request);
  return { summary: 'ok', text: 'child report ok' };
});
const defaulted = await runSubagentTool({ task: 'y', provider: 'default', model: 'default' }, ctx);
check('spawn_subagent treats "default" provider as inherit', defaulted.isError !== true);
check('"default" provider inherits the parent provider', capturedRequests[0]?.provider === 'ollama');
check('"default" model inherits the parent model', capturedRequests[0]?.model === 'qwen2.5-coder');

capturedRequests.length = 0;
await runSubagentTool({ task: 'clamp steps', maxSteps: 99 }, ctx);
check('spawn_subagent clamps requested child steps to the max cap', capturedRequests[0]?.maxSteps === MAX_CHILD_STEPS);

// W4/U3: the loop's per-call live-progress sink (ctx.onSubagentProgress) must reach
// the child runtime, which pushes partial text + tool trace onto the parent card.
const progressEvents: { text: string; traces: readonly string[] }[] = [];
const liveCtx: ToolContext = {
  ...ctx,
  onSubagentProgress: (p) => progressEvents.push(p),
};
setSubagentRunnerForTests(async (_request, runnerCtx) => {
  // Stand in for runChildAgent: emit one streamed chunk through the forwarded sink.
  runnerCtx.onSubagentProgress?.({ text: 'partial child output…', traces: ['read_file: ok'] });
  return { summary: 'ok', text: 'child report ok' };
});
await runSubagentTool({ task: 'stream', label: 'Streamer' }, liveCtx);
check('onSubagentProgress is forwarded from the loop ctx to the child runtime', progressEvents.length === 1);
check(
  'the streamed progress carries the child text + tool trace',
  progressEvents[0]?.text === 'partial child output…' && progressEvents[0]?.traces[0] === 'read_file: ok',
);
// Parallel fan-out (loop chunked dispatch): several children must be able to run
// CONCURRENTLY — the loop Promise.alls a run of consecutive spawn_subagent calls,
// so the child runtime must not serialize on shared state. Two delayed children
// must overlap in time.
{
  const stamps: { label: string; phase: 'start' | 'end'; at: number }[] = [];
  setSubagentRunnerForTests(async (request) => {
    stamps.push({ label: request.label, phase: 'start', at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 120));
    stamps.push({ label: request.label, phase: 'end', at: Date.now() });
    return { summary: 'ok', text: `report from ${request.label}` };
  });
  const [a, b] = await Promise.all([
    runSubagentTool({ task: 'left half', label: 'A' }, ctx),
    runSubagentTool({ task: 'right half', label: 'B' }, ctx),
  ]);
  check('parallel: both children report', a.text.includes('A') && b.text.includes('B'));
  const bStart = stamps.find((s) => s.label === 'B' && s.phase === 'start')!.at;
  const aEnd = stamps.find((s) => s.label === 'A' && s.phase === 'end')!.at;
  check('parallel: child B starts before child A finishes (true overlap)', bStart < aEnd);
}
setSubagentRunnerForTests(null);

console.log(`\nsubagent harness: ${passedCount()} assertions passed`);
