/**
 * Task-delegation reminder (SECOND-PASS "Task delegation reminder" / omo
 * `agent-usage-reminder`). An evidence-based, in-band nudge: when the agent has
 * made many DIRECT tool calls in a turn without ever delegating to a subagent
 * (while `spawn_subagent` is available), it is likely doing wide survey work
 * serially that a fan-out of children would do faster. A behavioral nudge at that
 * moment is cheaper and more reliable than a standing instruction in the system
 * prompt.
 *
 * Conservative by design: fires AT MOST ONCE per turn, only after a real run of
 * direct calls, and never after the agent has delegated (using spawn_subagent
 * resets/suppresses it — the agent already knows the tool exists). Counts only
 * "survey-ish" read tools by default, so a focused edit sequence isn't nagged.
 *
 * Pure + dependency-free (no imports), so it strips cleanly under the bare-node
 * harness and is unit-testable in isolation. Mirrors loop-detector.ts's shape.
 */

/** Per-turn state for the delegation reminder. */
export type DelegationReminderState = {
  /** Consecutive direct (non-delegating) survey tool calls so far this turn. */
  directCount: number;
  /** True once the agent has delegated (spawn_subagent) — suppresses the nudge. */
  delegated: boolean;
  /** True once the nudge has fired this turn — fires at most once. */
  fired: boolean;
};

/** Number of direct survey calls (with no delegation) that trips the reminder. */
export const DELEGATION_REMINDER_THRESHOLD = 8;

/**
 * Tools that count as "survey" work — read-only exploration a fan-out of
 * subagents could parallelize. A long run of these without delegating is the
 * signal. Edits / commands / browser actions are NOT counted (delegating those is
 * not the point).
 */
const SURVEY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'grep',
  'list_files',
  'lsp_navigate',
  'lsp_symbols',
  'read_diagnostics',
]);

export function emptyDelegationReminderState(): DelegationReminderState {
  return { directCount: 0, delegated: false, fired: false };
}

/** The result of recording one call: the advanced state + whether to nudge now. */
export type DelegationReminderResult = {
  state: DelegationReminderState;
  /** True on the single call that crosses the threshold (fires once per turn). */
  tripped: boolean;
};

/**
 * Record one cleared tool call against the reminder. A `spawn_subagent` call sets
 * `delegated` (permanently suppressing the nudge for the turn). A survey tool
 * increments the direct counter; the FIRST time it reaches the threshold — and
 * only if the agent has not delegated and the nudge hasn't fired — it trips.
 * Non-survey tools (edits/commands/etc.) are ignored: they neither count nor
 * reset, so an interleaved edit doesn't mask a survey run.
 */
export function recordDelegationCall(
  state: DelegationReminderState,
  name: string,
  isDelegation: boolean,
  threshold = DELEGATION_REMINDER_THRESHOLD,
): DelegationReminderResult {
  if (isDelegation) {
    return { state: { ...state, delegated: true }, tripped: false };
  }
  if (!SURVEY_TOOLS.has(name)) {
    return { state, tripped: false };
  }
  const directCount = state.directCount + 1;
  const next: DelegationReminderState = { ...state, directCount };
  if (!state.delegated && !state.fired && directCount >= threshold) {
    return { state: { ...next, fired: true }, tripped: true };
  }
  return { state: next, tripped: false };
}

/** The model-facing nudge injected when the reminder trips. */
export function delegationReminderNudge(directCount: number): string {
  return (
    `[delegation] You have run ${directCount} read/search calls directly this turn without delegating. ` +
    `For wide survey work, spawn_subagent lets you fan out several focused children that explore in PARALLEL ` +
    `and report back — usually faster and cheaper than reading file-by-file yourself. ` +
    `Consider issuing several spawn_subagent calls in one turn for the independent parts of this investigation. ` +
    `(If the remaining work is narrow or sequential, ignore this and continue.)`
  );
}
