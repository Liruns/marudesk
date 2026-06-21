/**
 * Same-input loop detector (SECOND-PASS item 4 / omo `loop-detector.ts`). A
 * circuit-breaker that trips when the model repeats the SAME tool call — same
 * name AND same argument signature — N times in a row, EVEN WHEN EACH SUCCEEDS.
 *
 * marudesk's existing `toolFailures` map only counts consecutive FAILURES, so a
 * "success-spin" — re-reading the same file, re-running the same grep, calling
 * the same MCP tool with identical args over and over while making no progress —
 * slips through until the 80-step turn budget finally cuts it off. This catches
 * it early with a corrective nudge.
 *
 * Pure + dependency-free (no imports), so it strips cleanly under the bare-node
 * harness and is unit-testable in isolation.
 */

/** Rolling state for the most-recent repeated tool signature on one thread/turn. */
export type LoopDetectorState = {
  /** Stable signature (`name::sortedJSON`) of the last observed call. */
  lastSignature: string;
  /** How many times in a row that exact signature has now been seen. */
  count: number;
  /**
   * Ring buffer of the most-recent call signatures (newest last), capped at
   * {@link LOOP_DETECTOR_WINDOW}. Drives the short-cycle oscillation check
   * (A-B-A-B / A-A-B-A-B) that the strictly-consecutive `count` misses.
   */
  recent: string[];
};

/** Trip after this many identical consecutive calls (the call that hits N trips). */
export const LOOP_DETECTOR_THRESHOLD = 4;

/**
 * How many recent signatures to retain for the oscillation check. Sized so a
 * sustained 2-signature cycle fills the window before it can trip — large enough
 * that a few legitimate alternating reads (e.g. A-B-A) stay well under the bar.
 */
export const LOOP_DETECTOR_WINDOW = 6;

/**
 * Trip the oscillation path when the last {@link LOOP_DETECTOR_CYCLE_MIN} calls
 * collapse to at most {@link LOOP_DETECTOR_CYCLE_DISTINCT} distinct signatures.
 * Requiring 6 calls over <=2 signatures means a real back-and-forth spin
 * (A-B-A-B-A-B) trips while a brief A-B-A or A-B-A-B does not.
 */
export const LOOP_DETECTOR_CYCLE_MIN = 6;

/** Max distinct signatures within the cycle window that still counts as a loop. */
export const LOOP_DETECTOR_CYCLE_DISTINCT = 2;

/** Fresh, empty state (no call seen yet). */
export function emptyLoopDetectorState(): LoopDetectorState {
  return { lastSignature: '', count: 0, recent: [] };
}

/**
 * Deterministically sort an object's keys (recursively) so two argument objects
 * that differ only in key order hash to the SAME signature. Arrays keep order
 * (order is semantically meaningful); primitives pass through.
 */
function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * A stable signature for a tool call — `name` alone when there are no args (or
 * unserializable args), else `name::<canonical-json>`. Key order is normalized
 * so `{a,b}` and `{b,a}` collide; a JSON.stringify failure (cycles) degrades to
 * the tool name (a coarser but safe key).
 */
export function toolCallSignature(name: string, input: unknown): string {
  if (input === null || input === undefined) return name;
  if (typeof input !== 'object') return `${name}::${String(input)}`;
  if (Array.isArray(input)) {
    try {
      return `${name}::${JSON.stringify(sortValue(input))}`;
    } catch {
      return name;
    }
  }
  const keys = Object.keys(input as Record<string, unknown>);
  if (keys.length === 0) return name;
  try {
    return `${name}::${JSON.stringify(sortValue(input))}`;
  } catch {
    return name;
  }
}

/** Which trip path fired: a strict consecutive run vs. a short A-B-A-B cycle. */
export type LoopDetectorKind = 'consecutive' | 'cycle';

/** The result of recording one call: the advanced state + whether it tripped. */
export type LoopDetectorResult = {
  state: LoopDetectorState;
  /** True on the call that reaches the threshold (fires exactly once per run). */
  tripped: boolean;
  /** The repeated tool name when tripped (for the nudge text), else undefined. */
  toolName?: string;
  /** Consecutive count at the trip, else the running count. */
  repeatedCount: number;
  /** Which path tripped (only meaningful when {@link tripped}); else undefined. */
  kind?: LoopDetectorKind;
};

/**
 * Record one (cleared, about-to-dispatch) tool call against the detector.
 *
 * Two trip paths, both gated on the trip firing EXACTLY once (the call that
 * crosses the bar) so the nudge is injected a single time:
 *
 *  (a) Consecutive run — increments when the signature matches the previous
 *      call, else resets to 1. Trips on the call that reaches `threshold`
 *      (`count === threshold`). Catches A-A-A-A.
 *  (b) Short-cycle oscillation — keeps a {@link LOOP_DETECTOR_WINDOW}-deep ring
 *      buffer and trips when the last {@link LOOP_DETECTOR_CYCLE_MIN} calls
 *      collapse to <= {@link LOOP_DETECTOR_CYCLE_DISTINCT} distinct signatures
 *      (A-B-A-B-A-B). Edge-triggered: it only fires on the call that first
 *      satisfies the condition (i.e. the previous window did not), so a
 *      sustained cycle nudges once rather than on every subsequent call.
 *
 * A still-repeating call past either bar keeps counting but `tripped` stays
 * false (the caller already nudged / will stop).
 */
export function recordToolCall(
  state: LoopDetectorState,
  name: string,
  input: unknown,
  threshold = LOOP_DETECTOR_THRESHOLD,
): LoopDetectorResult {
  const signature = toolCallSignature(name, input);
  const count = state.lastSignature === signature ? state.count + 1 : 1;
  const recent = [...state.recent, signature].slice(-LOOP_DETECTOR_WINDOW);
  const next: LoopDetectorState = { lastSignature: signature, count, recent };

  const consecutiveTrip = count === threshold;
  // Edge-trigger the oscillation path: fire only when THIS call completes a
  // qualifying cycle that the window WITHOUT it did not (so it nudges once).
  const cycleTrip = !consecutiveTrip && isCycleLoop(recent) && !isCycleLoop(state.recent);
  const tripped = consecutiveTrip || cycleTrip;
  const kind: LoopDetectorKind | undefined = consecutiveTrip
    ? 'consecutive'
    : cycleTrip
      ? 'cycle'
      : undefined;

  return {
    state: next,
    tripped,
    // For a cycle trip the consecutive `count` is meaningless (signatures
    // alternate); report the window depth so the nudge cites a real number.
    repeatedCount: cycleTrip ? LOOP_DETECTOR_CYCLE_MIN : count,
    ...(tripped ? { toolName: name, kind } : {}),
  };
}

/**
 * True when the most-recent calls form a short oscillation: at least
 * {@link LOOP_DETECTOR_CYCLE_MIN} calls whose tail collapses to BETWEEN 2 and
 * {@link LOOP_DETECTOR_CYCLE_DISTINCT} distinct signatures. A single repeated
 * signature (distinct === 1) is deliberately EXCLUDED — that is the consecutive
 * path's job, and reporting it here too would double-trip one spin and emit the
 * wrong "cycling between two calls" wording. Pure helper.
 */
function isCycleLoop(recent: readonly string[]): boolean {
  if (recent.length < LOOP_DETECTOR_CYCLE_MIN) return false;
  const window = recent.slice(-LOOP_DETECTOR_CYCLE_MIN);
  const distinct = new Set(window);
  return distinct.size > 1 && distinct.size <= LOOP_DETECTOR_CYCLE_DISTINCT;
}

/**
 * The model-facing nudge injected when the detector trips. The `consecutive`
 * variant describes an identical-call run (A-A-A-A); the `cycle` variant
 * describes a short oscillation (A-B-A-B-A-B). Both end with the same corrective
 * guidance. Defaults to `consecutive` for backward compatibility.
 */
export function loopDetectorNudge(
  toolName: string,
  repeatedCount: number,
  kind: LoopDetectorKind = 'consecutive',
): string {
  const lead =
    kind === 'cycle'
      ? `[loop] Your last ${repeatedCount} tool calls are cycling between the same two calls (including ${toolName}) ` +
        `without making progress — alternating between them will keep returning the same results. `
      : `[loop] You have called ${toolName} ${repeatedCount} times in a row with identical arguments. ` +
        `Each call returned, but you are not making progress — repeating the same call will keep returning the same result. `;
  return (
    lead +
    `Stop and change approach: use the results you already have, try DIFFERENT arguments or a different tool, ` +
    `or if you are stuck, call ask_user to get the user's help instead of looping.`
  );
}

/* ── Windowed recovery nudge (failure-driven, tool-agnostic) ──────────────── */

/** How many recent tool calls the windowed failure signal looks back over. */
export const FAILURE_WINDOW_SIZE = 6;
/**
 * Failures within the window that escalate recovery even across DIFFERENT tools.
 * The per-tool consecutive counter only escalates on the SAME tool failing in a
 * row, so a model alternating two failing tools (A,B,A,B…) never tripped it; this
 * windowed bar catches a turn that is mostly failing regardless of which tool.
 */
export const WINDOWED_FAILURE_THRESHOLD = 4;

/**
 * Record one tool call's outcome onto a sliding failure window (mutates in
 * place): push `1` for a failure / `0` for success and drop the oldest entry once
 * the window exceeds {@link FAILURE_WINDOW_SIZE}, so it always reflects the last
 * N calls of this turn.
 */
export function recordFailureWindow(window: number[], isError: boolean): void {
  window.push(isError ? 1 : 0);
  if (window.length > FAILURE_WINDOW_SIZE) window.shift();
}

/** Total failures currently inside the sliding window. */
export function windowedFailureCount(window: number[]): number {
  return window.reduce((n, v) => n + v, 0);
}

/**
 * Recovery nudge for a turn that keeps failing (§G4). Two escalation signals:
 *  - `consecutiveFailures`: the SAME tool failing in a row (2 → re-read / change
 *    approach; 3+ → this approach is stuck, solve it differently or ask_user).
 *  - `windowedFailures`: total failures across the recent window REGARDLESS of
 *    tool, so a model alternating two distinct failing tools (A,B,A,B…) — which
 *    the consecutive counter never catches — still escalates once enough of the
 *    window is failing.
 * Returns null when neither signal warrants a nudge (a single isolated error).
 */
export function recoveryHint(
  name: string,
  consecutiveFailures: number,
  windowedFailures: number,
): string | null {
  const stuck = consecutiveFailures >= 3 || windowedFailures >= WINDOWED_FAILURE_THRESHOLD;
  if (stuck) {
    return (
      `[recovery] tool calls keep failing this turn (${name} just failed; ` +
      `${windowedFailures} of the last ${FAILURE_WINDOW_SIZE} calls errored). ` +
      `Stop retrying this approach: either solve the problem a fundamentally different way, ` +
      `or call ask_user to get the user's help instead of guessing.`
    );
  }
  if (consecutiveFailures === 2) {
    return (
      `[recovery] ${name} has now failed twice in a row. Do not repeat the same call — ` +
      `re-read the relevant file/state (it may have changed) or take a different approach.`
    );
  }
  return null;
}
