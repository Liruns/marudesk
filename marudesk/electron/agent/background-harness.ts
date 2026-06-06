import assert from 'node:assert/strict';
import { listMcpTools } from './mcp.ts';
import {
  startBackgroundAgentTool,
  collectBackgroundTool,
  cancelBackgroundTool,
  cancelBackgroundForConversation,
  setBackgroundRunnerForTests,
  whenBackgroundSettled,
} from './background.ts';
import { S } from './loop-state.ts';
import type { ToolContext } from './tools/types.ts';
import type { SubagentRunRequest } from './subagent-types.ts';

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

// A background task id is extracted from the spawn ack text ("... agent <id> ...").
function ackId(text: string): string {
  return text.match(/agent (bg-[\w-]+)/)?.[1] ?? '';
}

const listed = listMcpTools();
check(
  'spawn_background_agent is listed for the model',
  listed.some((t) => t.name === 'spawn_background_agent'),
);
check(
  'spawn_background_agent requires per-call approval',
  listed.find((t) => t.name === 'spawn_background_agent')?.gated === true,
);
check(
  'collect/cancel are listed and non-gated',
  ['collect_background_agent', 'cancel_background_agent'].every((n) => {
    const def = listed.find((t) => t.name === n);
    return def !== undefined && def.gated !== true;
  }),
);

const ctx: ToolContext = {
  ws: null,
  signal: new AbortController().signal,
  provider: 'ollama',
  model: 'qwen2.5-coder',
};

// Active a conversation so registry scoping works (spawn happens mid-turn).
S.conversationId = 'session-bg-test';

/* ── happy path: spawn returns immediately, result collected after settle ── */
const captured: SubagentRunRequest[] = [];
let release: () => void = () => {};
setBackgroundRunnerForTests((request) => {
  captured.push(request);
  return new Promise((resolve) => {
    release = () =>
      resolve({
        summary: `done ${request.label}`,
        text: 'child background report ok',
      });
  });
});

const spawn = startBackgroundAgentTool({ task: 'investigate plumbing', label: 'BG' }, ctx);
const id = ackId(spawn.text);
check('spawn returns immediately without error', spawn.isError !== true && id.startsWith('bg-'));
check('spawn falls back to parent provider/model', captured[0]?.provider === 'ollama' && captured[0]?.model === 'qwen2.5-coder');
check('task projected as running', S.state.background.find((t) => t.id === id)?.status === 'running');

const running = collectBackgroundTool({ id });
check('collect while running reports running', running.text.includes('still running'));

release();
await whenBackgroundSettled(id);
check('task projected as done after settle', S.state.background.find((t) => t.id === id)?.status === 'done');

const done = collectBackgroundTool({ id });
check('collect after settle returns the report', done.text.includes('child background report ok'));
check('collected flag set', S.state.background.find((t) => t.id === id)?.collected === true);

/* ── cancel path ──────────────────────────────────────────────────────── */
setBackgroundRunnerForTests(
  (request) =>
    new Promise((resolve) => {
      // Never resolves on its own; only the abort drives it terminal.
      ctxSignalToResolve(request, resolve);
    }),
);
function ctxSignalToResolve(_r: SubagentRunRequest, resolve: (v: { summary: string; text: string; isError?: boolean }) => void): void {
  // Mimic runChildAgent: settle as an aborted failure when cancelled.
  setTimeout(() => resolve({ summary: 'aborted', text: 'aborted by user', isError: true }), 0);
}
const spawn2 = startBackgroundAgentTool({ task: 'long job', label: 'BG2' }, ctx);
const id2 = ackId(spawn2.text);
const cancelled = cancelBackgroundTool({ id: id2 });
check('cancel reports success', cancelled.isError !== true && cancelled.text.includes('Cancelled'));
check('task projected as cancelled', S.state.background.find((t) => t.id === id2)?.status === 'cancelled');
await whenBackgroundSettled(id2);
check('cancelled task stays cancelled after runner settles', S.state.background.find((t) => t.id === id2)?.status === 'cancelled');
collectBackgroundTool({ id: id2 });
check('collecting a cancelled task marks it collected', S.state.background.find((t) => t.id === id2)?.collected === true);

/* ── concurrency cap ──────────────────────────────────────────────────── */
setBackgroundRunnerForTests(() => new Promise(() => {})); // never settles → stays running
for (let i = 0; i < 4; i += 1) startBackgroundAgentTool({ task: `fill ${i}`, label: `F${i}` }, ctx);
const overflow = startBackgroundAgentTool({ task: 'one too many', label: 'OVER' }, ctx);
check('spawn beyond the active cap is rejected', overflow.isError === true && overflow.text.includes('Too many'));

/* ── input validation ─────────────────────────────────────────────────── */
const bad = startBackgroundAgentTool({ task: 'x', provider: 'not-a-provider' }, ctx);
check('spawn rejects unknown providers', bad.isError === true && bad.text.includes('unknown provider'));

/* ── conversation teardown drops tasks ────────────────────────────────── */
cancelBackgroundForConversation('session-bg-test');
check('reset-style teardown empties the projection', S.state.background.length === 0);
const listAfter = collectBackgroundTool({});
check('collect after teardown reports none', listAfter.text.includes('No background agents'));

setBackgroundRunnerForTests(null);
S.conversationId = null;
console.log(`\nbackground harness: ${passed} assertions passed`);
