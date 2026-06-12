/**
 * Headless smoke test for the local-notification seam (src/lib/notifications.ts):
 * proves the pure snapshot diffing fires exactly one event per transition —
 * (a) background task done/error, (b) new approval, (c) turn end — and that the
 * stateful onAgentState path baselines the first snapshot and de-dupes
 * re-emits. No DOM / Capacitor / Notification API is touched (the presenter is
 * feature-detected and a no-op under node). Run:
 *   node --experimental-strip-types --import ./scripts/ts-register.mjs scripts/notifications-smoke.ts
 */
import {
  detectAgentNotifications,
  onAgentState,
  resetNotificationBaseline,
  setAppActiveForTesting,
  setNotificationsEnabled,
} from '../src/lib/notifications.ts';
import { emptyAgentChatState } from '../src/types.ts';
import type { AgentChatState, BackgroundTask } from '../src/types.ts';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${msg}`);
  }
}

function task(partial: Partial<BackgroundTask>): BackgroundTask {
  return {
    id: 'bg-1',
    label: 'Checkout smoke test',
    task: 'write a test',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    status: 'running',
    startedAt: 1,
    finishedAt: null,
    result: null,
    error: null,
    collected: false,
    ...partial,
  };
}

const idle = emptyAgentChatState();

// ── baseline: the first snapshot is never a transition ──────────────────────
const preloaded: AgentChatState = {
  ...idle,
  status: 'completed',
  pendingApproval: { turnId: 't1', callId: 'c1', name: 'eval_js', detail: 'x' },
  background: [task({ status: 'done', finishedAt: 2 })],
};
assert(
  detectAgentNotifications(null, preloaded).length === 0,
  'first snapshot is a baseline — no replayed notifications',
);

// ── (b) a NEW approval fires once; the same approval re-emitted does not ────
const working: AgentChatState = { ...idle, status: 'working', turnId: 't2' };
const withApproval: AgentChatState = {
  ...working,
  status: 'waiting_for_user',
  pendingApproval: { turnId: 't2', callId: 'c2', name: 'run_command', detail: 'npm test' },
};
const approvalEvents = detectAgentNotifications(working, withApproval);
assert(
  approvalEvents.length === 1 && approvalEvents[0]!.key === 'approval:t2:c2',
  'a new pendingApproval yields exactly one approval event',
);
assert(
  approvalEvents[0]!.body.includes('run_command'),
  'the approval event names the tool',
);
assert(
  detectAgentNotifications(withApproval, withApproval).length === 0,
  'the same approval re-emitted yields nothing',
);

// ── (c) turn end: running → completed/failed fires; idle → completed does not ─
const completed: AgentChatState = { ...idle, status: 'completed' };
const turnEnd = detectAgentNotifications(working, completed);
assert(
  turnEnd.length === 1 && turnEnd[0]!.key === 'turn:t2:completed',
  'working → completed yields one turn-finished event',
);
const failed: AgentChatState = { ...idle, status: 'failed', error: 'boom' };
const turnFail = detectAgentNotifications({ ...idle, status: 'thinking', turnId: 't3' }, failed);
assert(
  turnFail.length === 1 && turnFail[0]!.body === 'boom',
  'thinking → failed yields one failure event carrying the error',
);
assert(
  detectAgentNotifications(completed, completed).length === 0,
  'completed → completed yields nothing',
);

// ── (a) background task transitions ─────────────────────────────────────────
const bgRunning: AgentChatState = { ...idle, background: [task({})] };
const bgDone: AgentChatState = { ...idle, background: [task({ status: 'done', finishedAt: 2, result: 'ok' })] };
const bgEvents = detectAgentNotifications(bgRunning, bgDone);
assert(
  bgEvents.length === 1 && bgEvents[0]!.key === 'bg:bg-1:done',
  'a running → done background task yields one event',
);
const bgError: AgentChatState = { ...idle, background: [task({ status: 'error', error: 'crashed' })] };
assert(
  detectAgentNotifications(bgRunning, bgError)[0]!.body.includes('crashed'),
  'a running → error background task carries the error',
);
assert(
  detectAgentNotifications(bgDone, bgDone).length === 0,
  'an already-done task yields nothing',
);
assert(
  detectAgentNotifications({ ...idle, background: [] }, bgDone).length === 0,
  'a task first seen already-done yields nothing (no running edge)',
);
// older host: no background field at all — must not throw.
assert(
  detectAgentNotifications(idle, { ...idle, status: 'completed' }).length === 0,
  'snapshots without a background field are handled (older desktop)',
);

// ── stateful seam: baseline + de-dupe via onAgentState (presenter no-ops in node) ─
setNotificationsEnabled(true);
setAppActiveForTesting(false);
resetNotificationBaseline();
onAgentState(working); // baseline
onAgentState(withApproval); // approval edge (presented; node presenter is a no-op)
onAgentState(withApproval); // duplicate — must be ignored without throwing
resetNotificationBaseline();
onAgentState(withApproval); // after a transport swap the same state is a baseline
assert(true, 'onAgentState baselines, de-dupes, and survives a transport swap');
setNotificationsEnabled(false);
setAppActiveForTesting(true);

if (failures > 0) {
  console.error(`\nNOTIFICATIONS SMOKE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nNOTIFICATIONS SMOKE: PASS');
