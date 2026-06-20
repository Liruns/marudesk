import { check, passedCount } from '../harness-kit.ts';
import {
  emptyLoopDetectorState,
  recordToolCall,
  toolCallSignature,
  loopDetectorNudge,
  LOOP_DETECTOR_THRESHOLD,
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

/* ── alternating calls never trip ────────────────────────────────────────── */
{
  let state: LoopDetectorState = emptyLoopDetectorState();
  let everTripped = false;
  for (let i = 0; i < 10; i++) {
    const r = recordToolCall(state, 'read_file', { path: i % 2 === 0 ? 'a.ts' : 'b.ts' });
    state = r.state;
    everTripped = everTripped || r.tripped;
  }
  check('alternating args never trip', !everTripped);
}

/* ── nudge text mentions the tool + count ────────────────────────────────── */
{
  const nudge = loopDetectorNudge('read_file', 4);
  check('nudge names the tool', nudge.includes('read_file'));
  check('nudge names the count', nudge.includes('4'));
  check('nudge tells the model to stop/change', /change approach|ask_user/i.test(nudge));
}

console.log(`\n${passedCount()} checks passed`);
