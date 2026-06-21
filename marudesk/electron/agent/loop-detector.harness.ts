import { check, passedCount } from '../harness-kit.ts';
import {
  emptyLoopDetectorState,
  recordToolCall,
  toolCallSignature,
  loopDetectorNudge,
  LOOP_DETECTOR_THRESHOLD,
  LOOP_DETECTOR_CYCLE_MIN,
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

console.log(`\n${passedCount()} checks passed`);
