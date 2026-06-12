import type { ToolResultPartLite } from './loop-helpers';

/**
 * Step budget for one agent turn. The drive loop in loop.ts is otherwise
 * unbounded — a model that keeps emitting tool calls (a pathological retry
 * loop, or an injected "never stop" instruction) would run until the user
 * notices and hits Stop. The budget is a backstop, not a pacing mechanism:
 * generous enough that a legitimate long task never feels it, while a runaway
 * turn is cut off with a visible label instead of spinning silently.
 *
 * Pure module (no electron imports) so the wind-down logic is unit-testable.
 */

/** Model round-trips allowed in one turn before the loop force-finishes. */
export const MAX_TURN_STEPS = 80;

/** With this many steps (or fewer) left, the model starts getting wind-down notes. */
export const STEP_WINDDOWN_AT = 5;

/**
 * The model-facing wind-down note for the step that just completed, or null
 * while the budget is comfortable. `stepsUsed` counts model round-trips taken
 * so far this turn. The final-step wording tells the model NOT to call tools,
 * so the turn ends with a useful summary instead of a mid-flight cutoff.
 */
export function stepLimitNote(stepsUsed: number, max = MAX_TURN_STEPS): string | null {
  const remaining = max - stepsUsed;
  if (remaining <= 0 || remaining > STEP_WINDDOWN_AT) return null;
  if (remaining === 1) {
    return '[limit] This turn is at its step limit — your NEXT reply is the last one. Do not call more tools: summarize what was done, what remains, and how to continue in a fresh message.';
  }
  return `[limit] This turn is approaching its step limit: at most ${remaining} model steps remain. Prioritize finishing the task; if it cannot be finished in that budget, wrap up with a summary of progress and what remains.`;
}

/**
 * Fold a loop-level note into the step's LAST tool result so it reaches the
 * model without inventing an extra transcript message (providers require the
 * strict assistant→tool alternation; a synthetic user/system message between
 * steps would not survive every provider's validation).
 */
export function appendNoteToLastToolResult(parts: ToolResultPartLite[], note: string): void {
  const last = parts[parts.length - 1];
  if (!last) return;
  if (last.output.type === 'content') {
    last.output.value.push({ type: 'text', text: note });
  } else {
    last.output.value = `${last.output.value}\n\n${note}`;
  }
}
