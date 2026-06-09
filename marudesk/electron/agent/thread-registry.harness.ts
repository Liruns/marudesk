import assert from 'node:assert/strict';
import type { SessionRecord } from '../../shared/context';
import {
  S,
  activeThreadId,
  busy,
  closeThread,
  containerForWorkspace,
  emit,
  listThreads,
  newThread,
  switchThread,
  MAIN_THREAD,
  __resetThreadsForTests,
} from './loop-state.ts';
import { deleteSavedSession, listSavedSessions, resumeSession } from './loop-sessions.ts';
import {
  deleteSessionTool,
  listSessionsTool,
  readSessionTool,
} from './context-executors.ts';
import { clearAllSessions, readSession, saveSession } from './sessions-store.ts';
import { abortTurn, acceptEdit, approveTool, respond, revertEdit } from './loop-turn-actions.ts';
import type { ToolContext } from './tools/types.ts';

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

function sessionRecord(id: string, title: string, workspaceId?: string): SessionRecord {
  const now = Date.now();
  return {
    id,
    ...(workspaceId ? { workspaceId } : {}),
    title,
    createdAt: now,
    updatedAt: now,
    provider: 'ollama',
    model: 'qwen-test',
    messageCount: 0,
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, contextTokens: 0 },
    transcript: [],
    edits: [],
    plan: null,
  };
}

async function main(): Promise<void> {
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

  // ── workspace scoping: threads and edit actions ─────────────────────────
  __resetThreadsForTests();
  const alphaThread = newThread('alpha');
  const betaThread = newThread('beta');
  check('unscoped thread list excludes workspace threads', listThreads().every((t) => !t.workspaceId));
  check(
    'workspace thread list includes only that workspace',
    listThreads('alpha').length === 1 && listThreads('alpha')[0]?.id === alphaThread,
  );
  check('workspace switch rejects another workspace thread', switchThread(betaThread, 'alpha') === false);
  check('workspace close rejects another workspace thread', closeThread(betaThread, 'alpha') === false);
  check('unscoped switch rejects a workspace thread id', switchThread(alphaThread) === false);
  check('unscoped close rejects a workspace thread id', closeThread(alphaThread) === false);

  const alphaContainer = containerForWorkspace('alpha');
  alphaContainer.state.edits.push({
    id: 'edit-alpha-accept',
    turnId: 'turn-alpha',
    path: 'alpha.txt',
    kind: 'create',
    before: null,
    after: 'alpha',
    status: 'applied',
    timestamp: 1,
  });
  check(
    'acceptEdit rejects an edit from another workspace',
    acceptEdit('edit-alpha-accept', 'beta').ok === false &&
      alphaContainer.state.edits[0]?.status === 'applied',
  );
  check(
    'acceptEdit accepts an edit from the owning workspace',
    acceptEdit('edit-alpha-accept', 'alpha').ok === true &&
      alphaContainer.state.edits[0]?.status === 'accepted',
  );
  alphaContainer.state.edits.push({
    id: 'edit-alpha-revert',
    turnId: 'turn-alpha',
    path: 'alpha-revert.txt',
    kind: 'create',
    before: null,
    after: 'alpha',
    status: 'applied',
    timestamp: 2,
  });
  const rejectedRevert = await revertEdit('edit-alpha-revert', 'beta');
  check(
    'revertEdit rejects an edit from another workspace before touching disk',
    rejectedRevert.ok === false &&
      rejectedRevert.reason === 'not-found' &&
      alphaContainer.state.edits[1]?.status === 'applied',
  );

  // ── workspace scoping: saved sessions ───────────────────────────────────
  await clearAllSessions();
  await saveSession(sessionRecord('session-alpha', 'Alpha session', 'alpha'));
  await saveSession(sessionRecord('session-beta', 'Beta session', 'beta'));
  await saveSession(sessionRecord('session-legacy', 'Legacy session'));

  const betaContainer = containerForWorkspace('beta');
  check('another workspace cannot delete alpha saved session', (await deleteSavedSession('session-alpha', betaContainer)) === false);
  check('rejected cross-workspace delete leaves the alpha record intact', (await readSession('session-alpha')) !== null);
  check('unscoped container cannot resume alpha saved session', (await resumeSession('session-alpha')) === false && S.conversationId !== 'session-alpha');
  check('owning workspace can resume its saved session', (await resumeSession('session-alpha', alphaContainer)) === true && alphaContainer.conversationId === 'session-alpha');
  check(
    'unscoped session list includes only legacy sessions',
    (await listSavedSessions(null)).map((session) => session.id).join(',') === 'session-legacy',
  );
  check(
    'workspace session list includes only that workspace',
    (await listSavedSessions('beta')).map((session) => session.id).join(',') === 'session-beta',
  );
  const alphaToolCtx: ToolContext = {
    ws: null,
    signal: new AbortController().signal,
    thread: alphaContainer,
  };
  const systemToolCtx: ToolContext = {
    ws: null,
    signal: new AbortController().signal,
    thread: S,
  };
  const alphaContextList = await listSessionsTool({ limit: 10 }, alphaToolCtx);
  check(
    'list_sessions tool includes only the running workspace sessions',
    alphaContextList.text.includes('session-alpha') && !alphaContextList.text.includes('session-beta'),
  );
  const systemContextList = await listSessionsTool({ limit: 10 }, systemToolCtx);
  check(
    'list_sessions tool in unscoped chat includes only legacy sessions',
    systemContextList.text.includes('session-legacy') && !systemContextList.text.includes('session-alpha'),
  );
  const crossRead = await readSessionTool({ id: 'session-beta' }, alphaToolCtx);
  check('read_session tool rejects another workspace session id', crossRead.isError === true);
  const crossDelete = await deleteSessionTool({ id: 'session-beta' }, alphaToolCtx);
  check(
    'delete_session tool rejects another workspace session id and leaves it intact',
    crossDelete.isError === true && (await readSession('session-beta')) !== null,
  );
  await clearAllSessions();

  console.log(`\nthread-registry harness: ${passed} assertions passed`);
}

await main();
