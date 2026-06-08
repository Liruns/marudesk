import assert from 'node:assert/strict';
import {
  S,
  activeThreadId,
  busy,
  closeThread,
  emit,
  listThreads,
  newThread,
  switchThread,
  MAIN_THREAD,
  __resetThreadsForTests,
} from './loop-state.ts';
import { abortTurn, approveTool, respond } from './loop-turn-actions.ts';

/**
 * Harness for the Stage 12-B-2 thread registry: new/switch/close + the mid-turn
 * switch guard, exercised against the real loop-state registry (emit() is a
 * no-op here — no renderer host). Run via `npm run harness:threads`.
 */

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

function main(): void {
  __resetThreadsForTests();

  check('starts with a single main thread, active', listThreads().length === 1 && activeThreadId() === MAIN_THREAD);
  check('main thread is active in the list', listThreads()[0]!.active === true);

  // Create a second thread — does NOT switch automatically.
  const t2 = newThread();
  check('newThread adds a thread without switching', listThreads().length === 2 && activeThreadId() === MAIN_THREAD);
  check('the new thread is listed and inactive', listThreads().some((t) => t.id === t2 && !t.active));

  // Switch to it: the active container becomes the new (empty) one.
  check('switchThread moves the active thread', switchThread(t2) === true && activeThreadId() === t2);
  check('switched-to thread is empty (fresh chat)', S.state.messages.length === 0 && S.conversationId === null);

  // Give the active thread a conversation, then verify the list reflects it.
  S.conversationId = 'sess-1';
  S.conversationTitle = 'Refactor the parser';
  S.state.messages.push({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }], timestamp: 1 });
  check('list reflects the active thread title + message count', listThreads().find((t) => t.id === t2)?.title === 'Refactor the parser');
  check('list reflects message count', listThreads().find((t) => t.id === t2)?.messageCount === 1);

  // Stage 12-B-2 concurrency: switching is allowed WHILE a thread is busy (turns
  // are container-bound, so the running thread keeps going in the background).
  S.state.status = 'working';
  check('busy() is true while working', busy() === true);
  check('switchThread works even while the current thread is busy', switchThread(MAIN_THREAD) === true && activeThreadId() === MAIN_THREAD);
  check('the switched-away thread is still busy in the list', listThreads().find((t) => t.id === t2)?.busy === true);
  // Reset t2 to idle so the later close assertions are clean.
  switchThread(t2);
  S.state.status = 'idle';
  switchThread(MAIN_THREAD);

  // Close handling.
  check('cannot close the last/only when one remains? (two exist) close inactive', closeThread(t2) === true && listThreads().length === 1);
  check('closing the active thread is refused when it is the last', closeThread(MAIN_THREAD) === false && listThreads().length === 1);

  // Closing the ACTIVE thread switches to a survivor.
  const t3 = newThread();
  switchThread(t3);
  check('active is the new thread', activeThreadId() === t3);
  // While that active thread is busy, closing it aborts its turn (captured ref).
  S.state.status = 'working';
  const t3ctrl = new AbortController();
  S.controller = t3ctrl;
  check('closing the active busy thread aborts its turn + falls back', closeThread(t3) === true && t3ctrl.signal.aborted === true && activeThreadId() === MAIN_THREAD && listThreads().length === 1);

  // unknown ids are rejected.
  check('switching to an unknown thread is rejected', switchThread('nope') === false);
  check('closing an unknown thread is rejected', closeThread('nope') === false);

  // emit() must be safe with no renderer host.
  emit();
  check('emit() is a no-op without a host (no throw)', true);

  // ── concurrent turn-control routing (Stage 12-B-2) ──────────────────────
  __resetThreadsForTests();
  // The MAIN (soon non-active) thread parks an approval for 'turnA'.
  let aApproved: boolean | null = null;
  S.state.turnId = 'turnA';
  S.state.pendingApproval = { turnId: 'turnA', callId: 'cA', name: 'eval_js', detail: '' };
  S.approvalResolver = (d) => {
    aApproved = d.approved;
  };
  // A SECOND thread (becomes active) parks an ask_user for 'turnB'.
  const tb = newThread();
  switchThread(tb);
  let bAnswered: Record<string, string> | null = null;
  S.state.turnId = 'turnB';
  S.state.pendingQuestions = { turnId: 'turnB', callId: 'cB', questions: [{ id: 'q', question: '?' }] };
  S.answersResolver = (a) => {
    bAnswered = a;
  };
  // Approve turnA — must route to the NON-active main thread by turnId.
  check('approveTool routes to a parked NON-active thread by turnId', approveTool('turnA', 'cA', true) === true && aApproved === true);
  // Respond to turnB (the active thread).
  check('respond routes by turnId', respond('turnB', 'cB', { q: 'yes' }) === true && (bAnswered as Record<string, string> | null)?.q === 'yes');
  check('approve/respond reject an unknown turnId', approveTool('nope', 'x', true) === false && respond('nope', 'x', {}) === false);
  // abort routes by turnId across threads too.
  S.controller = new AbortController();
  const bCtrl = S.controller;
  check('abortTurn routes by turnId + aborts that thread', abortTurn('turnB') === true && bCtrl.signal.aborted === true);
  check('abortTurn for an unknown turnId is rejected', abortTurn('nope') === false);

  console.log(`\nthread-registry harness: ${passed} assertions passed`);
}

main();
