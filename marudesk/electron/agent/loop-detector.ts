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
};

/** Trip after this many identical consecutive calls (the call that hits N trips). */
export const LOOP_DETECTOR_THRESHOLD = 4;

/** Fresh, empty state (no call seen yet). */
export function emptyLoopDetectorState(): LoopDetectorState {
  return { lastSignature: '', count: 0 };
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

/** The result of recording one call: the advanced state + whether it tripped. */
export type LoopDetectorResult = {
  state: LoopDetectorState;
  /** True on the call that reaches the threshold (fires exactly once per run). */
  tripped: boolean;
  /** The repeated tool name when tripped (for the nudge text), else undefined. */
  toolName?: string;
  /** Consecutive count at the trip, else the running count. */
  repeatedCount: number;
};

/**
 * Record one (cleared, about-to-dispatch) tool call against the detector.
 * Increments the run when the signature matches the previous call, else resets
 * to 1 for the new signature. Trips EXACTLY on the call that reaches
 * {@link LOOP_DETECTOR_THRESHOLD} (`count === threshold`) so the nudge is
 * injected once; a still-repeating call past the threshold keeps counting but
 * `tripped` stays false (the caller already nudged / will stop).
 */
export function recordToolCall(
  state: LoopDetectorState,
  name: string,
  input: unknown,
  threshold = LOOP_DETECTOR_THRESHOLD,
): LoopDetectorResult {
  const signature = toolCallSignature(name, input);
  const count = state.lastSignature === signature ? state.count + 1 : 1;
  const next: LoopDetectorState = { lastSignature: signature, count };
  const tripped = count === threshold;
  return {
    state: next,
    tripped,
    repeatedCount: count,
    ...(tripped ? { toolName: name } : {}),
  };
}

/** The model-facing nudge injected when the detector trips. */
export function loopDetectorNudge(toolName: string, repeatedCount: number): string {
  return (
    `[loop] You have called ${toolName} ${repeatedCount} times in a row with identical arguments. ` +
    `Each call returned, but you are not making progress — repeating the same call will keep returning the same result. ` +
    `Stop and change approach: use the result you already have, try DIFFERENT arguments or a different tool, ` +
    `or if you are stuck, call ask_user to get the user's help instead of looping.`
  );
}
