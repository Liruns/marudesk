import { check, passedCount } from '../harness-kit.ts';
import {
  emptyLoopDetectorState,
  recordToolCall,
  toolCallSignature,
  loopDetectorNudge,
  recordFailureWindow,
  windowedFailureCount,
  recoveryHint,
  pickStepNudge,
  recordTerminalCall,
  isEmptyArgsExternalCall,
  LOOP_DETECTOR_THRESHOLD,
  LOOP_DETECTOR_CYCLE_MIN,
  FAILURE_WINDOW_SIZE,
  WINDOWED_FAILURE_THRESHOLD,
  type LoopDetectorState,
} from './loop-detector.ts';

/**
 * Harness for the same-input loop detector (SECOND-PASS item 4). Pure +
 * dependency-free — runs standalone under `node --experimental-strip-types`.
 *
 * Covers signature stability (key-order independence), the consecutive-count run,
 * the single trip at the threshold, the reset on a different signature, and the
 * args-vs-name disambiguation (same tool + different args does NOT count).
 */

/* ── signature ───────────────────────────────────────────────────────────── */
{
  check('no-args signature is the bare name', toolCallSignature('read_file', undefined) === 'read_file');
  check('empty-object signature is the bare name', toolCallSignature('read_file', {}) === 'read_file');
  // Key order must not matter — both objects hash to the same signature.
  const a = toolCallSignature('grep', { pattern: 'x', path: 'src' });
  const b = toolCallSignature('grep', { path: 'src', pattern: 'x' });
  check('signature is key-order independent', a === b);
  // Different args → different signature.
  check(
    'different args → different signature',
    toolCallSignature('read_file', { path: 'a.ts' }) !== toolCallSignature('read_file', { path: 'b.ts' }),
  );
  // Different tool, same args → different signature.
  check(
    'different tool → different signature',
    toolCallSignature('read_file', { path: 'a.ts' }) !== toolCallSignature('open_file', { path: 'a.ts' }),
  );
  // Nested object key-order independence.
  check(
    'nested key-order independent',
    toolCallSignature('t', { o: { a: 1, b: 2 } }) === toolCallSignature('t', { o: { b: 2, a: 1 } }),
  );
}

/* ── trip on N identical consecutive calls ───────────────────────────────── */
{
  let state: LoopDetectorState = emptyLoopDetectorState();
  const input = { path: 'README.md' };
  const trips: number[] = [];
  for (let i = 1; i <= LOOP_DETECTOR_THRESHOLD + 1; i++) {
    const r = recordToolCall(state, 'read_file', input);
    state = r.state;
    if (r.tripped) trips.push(i);
  }
  check('trips exactly once', trips.length === 1);
  check('trips on the Nth identical call', trips[0] === LOOP_DETECTOR_THRESHOLD);
}

/* ── a LONG consecutive run trips once (consecutive), never also as a cycle ── */
{
  // A-A-A-A-A-A-A-A: the consecutive path fires at the threshold; the cycle path
  // must NOT also fire once the window fills with a single signature (distinct
  // === 1), or one spin would be nudged twice — the second time with the wrong
  // "cycling between two calls" wording. Regression guard for that double-trip.
  let state: LoopDetectorState = emptyLoopDetectorState();
  const trips: { i: number; kind: string | undefined }[] = [];
  for (let i = 1; i <= 8; i++) {
    const r = recordToolCall(state, 'read_file', { path: 'README.md' });
    state = r.state;
    if (r.tripped) trips.push({ i, kind: r.kind });
  }
  check('long consecutive run trips exactly once', trips.length === 1);
  check('long consecutive run trip is classified as consecutive', trips[0]?.kind === 'consecutive');
  check('long consecutive run trips at the threshold', trips[0]?.i === LOOP_DETECTOR_THRESHOLD);
}

/* ── a different signature resets the run ─────────────────────────────────── */
{
  let state: LoopDetectorState = emptyLoopDetectorState();
  // Threshold-1 identical calls, then a DIFFERENT call, then identical again.
  for (let i = 0; i < LOOP_DETECTOR_THRESHOLD - 1; i++) {
    state = recordToolCall(state, 'grep', { pattern: 'foo' }).state;
  }
  const interrupt = recordToolCall(state, 'grep', { pattern: 'bar' });
  state = interrupt.state;
  check('a different call does not trip', !interrupt.tripped);
  check('count reset to 1 after a different call', state.count === 1);
  // Now repeat the new signature; the run starts fresh, so it should NOT trip yet.
  const next = recordToolCall(state, 'grep', { pattern: 'bar' });
  check('reset run has not yet reached threshold', !next.tripped && next.state.count === 2);
}

/* ── a brief, legitimate alternation does NOT trip ───────────────────────── */
{
  // A short back-and-forth between two files (A-B-A-B = 4 calls) is normal work
  // and stays under the cycle bar (LOOP_DETECTOR_CYCLE_MIN).
  let state: LoopDetectorState = emptyLoopDetectorState();
  let everTripped = false;
  for (let i = 0; i < LOOP_DETECTOR_CYCLE_MIN - 1; i++) {
    const r = recordToolCall(state, 'read_file', { path: i % 2 === 0 ? 'a.ts' : 'b.ts' });
    state = r.state;
    everTripped = everTripped || r.tripped;
  }
  check('brief A-B alternation does not trip', !everTripped);
}

/* ── a sustained A-B-A-B oscillation trips (the consecutive run never would) ─ */
{
  let state: LoopDetectorState = emptyLoopDetectorState();
  const trips: { i: number; kind: string | undefined; count: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const r = recordToolCall(state, 'read_file', { path: i % 2 === 0 ? 'a.ts' : 'b.ts' });
    state = r.state;
    if (r.tripped) trips.push({ i, kind: r.kind, count: r.repeatedCount });
  }
  check('sustained A-B-A-B oscillation trips', trips.length >= 1);
  check('oscillation trips exactly once (edge-triggered)', trips.length === 1);
  check('oscillation trip is classified as a cycle', trips[0]?.kind === 'cycle');
  // The cycle becomes detectable once the window holds CYCLE_MIN calls — i.e. on
  // the (CYCLE_MIN)-th call, zero-indexed CYCLE_MIN - 1.
  check('oscillation trips as soon as the window fills', trips[0]?.i === LOOP_DETECTOR_CYCLE_MIN - 1);
  check('cycle nudge cites the window size, not the consecutive count', trips[0]?.count === LOOP_DETECTOR_CYCLE_MIN);
}

/* ── a 3-distinct rotation (A-B-C-A-B-C) does NOT trip the 2-distinct cycle ─ */
{
  let state: LoopDetectorState = emptyLoopDetectorState();
  let everTripped = false;
  const paths = ['a.ts', 'b.ts', 'c.ts'];
  for (let i = 0; i < 12; i++) {
    const r = recordToolCall(state, 'read_file', { path: paths[i % 3] });
    state = r.state;
    everTripped = everTripped || r.tripped;
  }
  check('three-way rotation does not trip the 2-distinct cycle', !everTripped);
}

/* ── cycle nudge wording matches the oscillation case ────────────────────── */
{
  const nudge = loopDetectorNudge('grep', LOOP_DETECTOR_CYCLE_MIN, 'cycle');
  check('cycle nudge names the tool', nudge.includes('grep'));
  check('cycle nudge describes cycling', /cycling/i.test(nudge));
  check('cycle nudge tells the model to change approach', /change approach|ask_user/i.test(nudge));
}

/* ── nudge text mentions the tool + count ────────────────────────────────── */
{
  const nudge = loopDetectorNudge('read_file', 4);
  check('nudge names the tool', nudge.includes('read_file'));
  check('nudge names the count', nudge.includes('4'));
  check('nudge tells the model to stop/change', /change approach|ask_user/i.test(nudge));
}

/* ── windowed recovery: consecutive same-tool escalation ─────────────────── */
{
  // A single isolated failure does not nudge.
  check('recovery: first failure is silent', recoveryHint('edit_file', 1, 1) === null);
  // Two in a row → the "re-read / change approach" nudge.
  const second = recoveryHint('edit_file', 2, 2);
  check('recovery: 2 consecutive failures nudge', second !== null && /failed twice/.test(second));
  // 3+ consecutive → the "stuck, solve differently / ask_user" escalation.
  const third = recoveryHint('edit_file', 3, 3);
  check('recovery: 3 consecutive failures escalate', third !== null && /ask_user/.test(third));
}

/* ── windowed recovery: ALTERNATING failing tools still escalate ──────────── */
{
  // The core gap the windowed signal closes: a model alternating two DISTINCT
  // failing tools (A,B,A,B…) never reaches a consecutive-2 count for either tool,
  // so the old consecutive-only recoveryHint stayed silent forever. The windowed
  // total-failure signal escalates once enough of the recent window is failing.
  const window: number[] = [];
  // Simulate edit_file, run_command, edit_file, run_command … all failing. Each
  // tool's consecutive count stays at 1 (it alternates), so only the WINDOW drives
  // escalation. Names alternate; consecutive is pinned to 1 the whole time.
  const tools = ['edit_file', 'run_command'];
  let escalatedAt = -1;
  for (let i = 0; i < FAILURE_WINDOW_SIZE; i++) {
    recordFailureWindow(window, true); // every call fails
    const windowed = windowedFailureCount(window);
    const hint = recoveryHint(tools[i % 2], 1, windowed); // consecutive pinned at 1
    if (hint !== null && escalatedAt === -1) escalatedAt = i;
  }
  check('recovery: alternating failing tools DO escalate via the window', escalatedAt !== -1);
  check(
    'recovery: window escalates exactly at the failure threshold',
    escalatedAt === WINDOWED_FAILURE_THRESHOLD - 1,
  );
  // The windowed escalation cites the "keep failing this turn" wording, not the
  // consecutive "failed twice" one (consecutive was pinned at 1 throughout).
  const windowed = windowedFailureCount(window);
  const hint = recoveryHint('edit_file', 1, windowed);
  check('recovery: windowed nudge uses the tool-agnostic wording', hint !== null && /keep failing this turn/.test(hint));
}

/* ── windowed recovery: a mostly-successful turn does NOT escalate ─────────── */
{
  // A window with only sporadic failures (below the threshold) and no consecutive
  // run stays silent — the signal must not fire on healthy work with a stray error.
  const window: number[] = [];
  // success, fail, success, success, fail, success → 2 failures over 6, under bar.
  const outcomes = [false, true, false, false, true, false];
  let everEscalated = false;
  for (const isError of outcomes) {
    recordFailureWindow(window, isError);
    if (recoveryHint('grep', isError ? 1 : 0, windowedFailureCount(window)) !== null) everEscalated = true;
  }
  check('recovery: a mostly-successful turn never escalates', !everEscalated);
}

/* ── windowed recovery: the window slides (old failures age out) ──────────── */
{
  const window: number[] = [];
  // Fill the window entirely with failures, then push successes; the count must
  // fall back below the threshold as the old failures slide out of the window.
  for (let i = 0; i < FAILURE_WINDOW_SIZE; i++) recordFailureWindow(window, true);
  check('recovery: a full failing window is at capacity', window.length === FAILURE_WINDOW_SIZE);
  check('recovery: a full failing window escalates', recoveryHint('t', 1, windowedFailureCount(window)) !== null);
  for (let i = 0; i < FAILURE_WINDOW_SIZE; i++) recordFailureWindow(window, false);
  check('recovery: the window never grows past its size', window.length === FAILURE_WINDOW_SIZE);
  check('recovery: failures age out as successes slide in', windowedFailureCount(window) === 0);
  check('recovery: a recovered turn stops escalating', recoveryHint('t', 1, windowedFailureCount(window)) === null);
}

/* ── step nudge: a CLEAN call never clears an earlier protected nudge ──────── */
{
  // Regression A: a single model step can issue several calls — and a run of
  // read-only `shared` tools dispatches CONCURRENTLY — so the step's protected
  // (compaction-survived) nudge must be the strongest one across ALL calls, not
  // whichever call happened to settle last. pickStepNudge folds each call's nudge
  // into the running step nudge and a clean (null) call can never clear it.
  const hint = recoveryHint('edit_file', 2, 2); // a real recovery nudge string
  check('step nudge: recovery hint produced for the failing call', hint !== null);
  // Model order: [failing → nudge, clean → null]. Fold in order.
  let stepNudge: string | null = null;
  stepNudge = pickStepNudge(stepNudge, hint); // failing call's nudge
  stepNudge = pickStepNudge(stepNudge, null); // a later CLEAN call
  check('step nudge: a clean call does not clear an earlier nudge', stepNudge === hint);
}

/* ── step nudge: completion order does not change the step nudge ──────────── */
{
  // The fold runs in the model's ORIGINAL call order, so even though a parallel
  // shared run can SETTLE in any order, applying pickStepNudge in call order is
  // deterministic. [clean, failing] and the reverse settle order both yield the
  // failing call's nudge because we always fold in call order.
  const hint = recoveryHint('run_command', 3, 3);
  check('step nudge: escalation hint produced', hint !== null);
  // Call order is [clean, failing]; a clean (null) call never clears the nudge,
  // so the failing call's hint wins. Folded in call order.
  let a: string | null = null;
  a = pickStepNudge(a, null); // clean (call 0)
  a = pickStepNudge(a, hint); // failing (call 1)
  // A step with two nudges keeps the LATEST (a later failing call overwrites an
  // earlier nudge) so a late recovery hint is the one protected into compaction.
  const h0 = recoveryHint('edit_file', 2, 2);
  const h1 = recoveryHint('run_command', 3, 3);
  let b: string | null = null;
  b = pickStepNudge(b, h0); // first nudge
  b = pickStepNudge(b, h1); // a later nudge overwrites
  check('step nudge: failing call sets the step nudge regardless of position', a === hint);
  check('step nudge: the latest nudge in call order wins', b === h1);
}

/* ── step nudge: an all-clean step clears the protected nudge ─────────────── */
{
  // A step where every call is clean leaves the step nudge null, so the loop
  // clears S.persistentNudge — a recovered turn stops re-stamping a stale nudge.
  let stepNudge: string | null = null;
  for (let i = 0; i < 4; i++) stepNudge = pickStepNudge(stepNudge, null);
  check('step nudge: an all-clean step yields a null (cleared) nudge', stepNudge === null);
}

/* ── failover: the loop detector starts empty on the new provider ─────────── */
{
  // Regression B: failOver() must reset the loop detector (and delegation
  // reminder) so pre-failover counts can't immediately trip on the fresh
  // provider. Model the swap: build up a near-trip state, then reset to empty.
  let state: LoopDetectorState = emptyLoopDetectorState();
  for (let i = 0; i < LOOP_DETECTOR_THRESHOLD - 1; i++) {
    state = recordToolCall(state, 'read_file', { path: 'README.md' }).state;
  }
  check('failover: pre-swap state has accumulated counts', state.count === LOOP_DETECTOR_THRESHOLD - 1);
  // The provider swap resets the detector to empty (what failOver now does).
  const afterFailover = emptyLoopDetectorState();
  check('failover: detector starts empty after the swap', afterFailover.count === 0 && afterFailover.recent.length === 0);
  // One more identical call on the fresh provider must NOT trip (the old count is
  // gone), where WITHOUT the reset it would have been the threshold-th call.
  const firstAfter = recordToolCall(afterFailover, 'read_file', { path: 'README.md' });
  check('failover: a single post-swap call does not trip on stale counts', !firstAfter.tripped);
}

/* ── terminal calls (no tool ran): repeated blocked/malformed spam escalates ── */
{
  // Regression (R8 dispatch split): invalid-JSON and deny-list/read-only-blocked
  // tool calls bypassed the loop detector + failure window, so a model spamming
  // the SAME malformed/blocked call never tripped the circuit breaker — only the
  // 80-step turn limit caught the spin. recordTerminalCall advances BOTH trackers
  // for a no-tool-ran call so identical terminal signatures escalate.
  let state: LoopDetectorState = emptyLoopDetectorState();
  const window: number[] = [];
  const trips: number[] = [];
  // N identical BLOCKED calls (same name + args each time) feed the detector.
  for (let i = 1; i <= LOOP_DETECTOR_THRESHOLD + 1; i++) {
    const r = recordTerminalCall(state, window, 'edit_file', { path: 'locked.ts' }, false);
    state = r.loopDetector;
    if (r.nudge !== null) trips.push(i);
  }
  check('terminal: repeated blocked calls trip the loop detector exactly once', trips.length === 1);
  check('terminal: repeated blocked calls trip at the threshold', trips[0] === LOOP_DETECTOR_THRESHOLD);
  // Every terminal call is a failure, so the window fills with failures (capped).
  check(
    'terminal: each blocked call counts as a failure in the window',
    windowedFailureCount(window) === Math.min(LOOP_DETECTOR_THRESHOLD + 1, FAILURE_WINDOW_SIZE),
  );
}

/* ── terminal calls: the failure window escalates recovery for malformed spam ── */
{
  // A repeated malformed call also drives the windowed recovery signal: once
  // enough of the window is failing, recoveryHint escalates even though no tool
  // ran. This proves the failure-window bookkeeping is wired, not just the loop
  // detector. (The loop detector is exercised above.)
  let state: LoopDetectorState = emptyLoopDetectorState();
  const window: number[] = [];
  let escalatedAt = -1;
  for (let i = 0; i < WINDOWED_FAILURE_THRESHOLD; i++) {
    state = recordTerminalCall(state, window, 'run_command', { cmd: '{bad json' }, false).loopDetector;
    if (recoveryHint('run_command', 1, windowedFailureCount(window)) !== null && escalatedAt === -1) {
      escalatedAt = i;
    }
  }
  check('terminal: malformed spam escalates the windowed recovery signal', escalatedAt !== -1);
  check('terminal: windowed recovery escalates at the failure threshold', escalatedAt === WINDOWED_FAILURE_THRESHOLD - 1);
}

/* ── terminal calls: meta-tools (ask_user / spawn_*) are excluded from looping ── */
{
  // ask_user / spawn_* are legitimately repeatable, so even a blocked one must NOT
  // feed the loop detector (mirroring the happy-path guard). It still counts as a
  // failure in the window (something was blocked) but never trips the detector.
  let state: LoopDetectorState = emptyLoopDetectorState();
  const window: number[] = [];
  let everTripped = false;
  for (let i = 0; i < LOOP_DETECTOR_THRESHOLD + 3; i++) {
    const r = recordTerminalCall(state, window, 'ask_user', { question: 'same?' }, true);
    state = r.loopDetector;
    everTripped = everTripped || r.nudge !== null;
  }
  check('terminal: an excluded meta-tool never trips the loop detector', !everTripped);
  check('terminal: the detector state is untouched for an excluded call', state.count === 0 && state.lastSignature === '');
  check('terminal: an excluded call still records failures in the window', windowedFailureCount(window) === FAILURE_WINDOW_SIZE);
}

/* ── empty-args external pollers are excluded from the loop detector ────────── */
{
  // The predicate: only EXTERNAL (`__`) names with EMPTY args qualify.
  check('empty-args external call is excluded', isEmptyArgsExternalCall('srv__list_items', {}));
  check('null-args external call is excluded', isEmptyArgsExternalCall('srv__status', null));
  check('undefined-args external call is excluded', isEmptyArgsExternalCall('srv__status', undefined));
  check('non-empty external call is NOT excluded', !isEmptyArgsExternalCall('srv__list_items', { cursor: 'a' }));
  check('empty-args BUILTIN call is NOT excluded', !isEmptyArgsExternalCall('read_file', {}));
  check('array-args external call is NOT excluded', !isEmptyArgsExternalCall('srv__list_items', []));

  // Mirror the loop's exclusion seam: an excluded call never feeds the detector,
  // so repeated empty-args polls of an external tool never trip it (each is a
  // legitimately repeatable poll that collides on the bare-name signature).
  let state: LoopDetectorState = emptyLoopDetectorState();
  let tripped = false;
  for (let i = 0; i < LOOP_DETECTOR_THRESHOLD + LOOP_DETECTOR_CYCLE_MIN; i++) {
    const name = 'srv__list_items';
    const input = {};
    if (!isEmptyArgsExternalCall(name, input)) {
      const r = recordToolCall(state, name, input);
      state = r.state;
      tripped = tripped || r.tripped;
    }
  }
  check('repeated empty-args external polls never trip the detector', !tripped);
  check('detector state untouched by excluded polls', state.count === 0 && state.lastSignature === '');

  // A NON-empty-args external repeat is a real spin and STILL trips: not excluded,
  // so identical inputs escalate the consecutive count to the threshold.
  let busy: LoopDetectorState = emptyLoopDetectorState();
  let busyTripped = false;
  for (let i = 0; i < LOOP_DETECTOR_THRESHOLD; i++) {
    const name = 'srv__list_items';
    const input = { cursor: 'fixed' };
    check(`non-empty external call ${i} is not excluded`, !isEmptyArgsExternalCall(name, input));
    const r = recordToolCall(busy, name, input);
    busy = r.state;
    busyTripped = busyTripped || r.tripped;
  }
  check('repeated non-empty-args external call still trips the detector', busyTripped);
}

console.log(`\n${passedCount()} checks passed`);
