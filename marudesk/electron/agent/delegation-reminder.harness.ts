import { check, passedCount } from '../harness-kit.ts';
import {
  emptyDelegationReminderState,
  recordDelegationCall,
  DELEGATION_REMINDER_THRESHOLD,
} from './delegation-reminder.ts';

/**
 * Harness for the task-delegation reminder (SECOND-PASS "Task delegation
 * reminder"). Pure, runs under bare `node --experimental-strip-types`. Asserts:
 * it trips after a threshold of direct survey reads, fires exactly once per turn,
 * a delegation suppresses it, and non-survey tools neither count nor reset.
 */

const T = DELEGATION_REMINDER_THRESHOLD;

/* ── trips after the threshold of direct survey reads, fires once ───────── */
{
  let state = emptyDelegationReminderState();
  let trips = 0;
  for (let i = 0; i < T + 3; i += 1) {
    const r = recordDelegationCall(state, 'read_file', false);
    state = r.state;
    if (r.tripped) trips += 1;
  }
  check(`trips exactly once across ${T + 3} survey reads`, trips === 1);
  check('directCount keeps counting past the trip', state.directCount === T + 3);
}

/* ── trips on the exact threshold call ──────────────────────────────────── */
{
  let state = emptyDelegationReminderState();
  let trippedAt = -1;
  for (let i = 0; i < T; i += 1) {
    const r = recordDelegationCall(state, 'grep', false);
    state = r.state;
    if (r.tripped) trippedAt = i + 1;
  }
  check(`trips on the ${T}th survey call`, trippedAt === T);
}

/* ── a delegation suppresses the reminder permanently ───────────────────── */
{
  let state = emptyDelegationReminderState();
  // Delegate first, then do many reads — must never trip.
  state = recordDelegationCall(state, 'spawn_subagent', true).state;
  let trips = 0;
  for (let i = 0; i < T + 5; i += 1) {
    const r = recordDelegationCall(state, 'read_file', false);
    state = r.state;
    if (r.tripped) trips += 1;
  }
  check('a prior delegation suppresses the nudge', trips === 0 && state.delegated === true);
}

/* ── non-survey tools neither count nor reset ───────────────────────────── */
{
  let state = emptyDelegationReminderState();
  // Interleave an edit between reads — it must not count toward the threshold,
  // and must not reset the survey run.
  for (let i = 0; i < T - 1; i += 1) state = recordDelegationCall(state, 'read_file', false).state;
  state = recordDelegationCall(state, 'edit_file', false).state; // ignored
  check('a non-survey tool does not increment the counter', state.directCount === T - 1);
  const r = recordDelegationCall(state, 'read_file', false);
  check('the next survey read still trips (edit did not reset)', r.tripped === true);
}

console.log(`\ndelegation-reminder harness: ${passedCount()} checks passed`);
