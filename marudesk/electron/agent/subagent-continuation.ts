/**
 * Sub-session continuation store (SECOND-PASS "Sub-session continuation ID").
 *
 * A foreground child agent ({@link ./subagent-runtime.ts}) returns plain report
 * text and DISCARDS its transcript, so each follow-up spawn starts cold and
 * re-explores the workspace — wasted tokens. This is the resume substrate: on
 * completion a child persists its transcript here under a fresh continuation id,
 * surfaces that id in its report, and a later spawn that passes `resume: <id>`
 * SEEDS its transcript from the stored one (the new task rides on as a follow-up
 * user turn) instead of starting from scratch.
 *
 * Process-global (single Electron main process) and bounded: an LRU cap evicts the
 * oldest continuations so a long session can't grow this without limit, and the
 * whole store is cleared on conversation reset/resume (the next chat starts fresh).
 * The stored value is the provider-neutral {@link ModelMessage}[] the child loop
 * already builds, so a resume is provider-agnostic (it can fail over to a
 * different model). Pure data — no Electron imports; relative value imports use an
 * explicit `.ts` extension for the harness loader.
 */
import type { ModelMessage } from 'ai';

/** Max continuations retained at once; oldest are evicted (LRU by insertion). */
const MAX_CONTINUATIONS = 32;

/** Insertion-ordered map: the first key is the oldest (eviction target). */
const store = new Map<string, readonly ModelMessage[]>();
let seq = 0;

/** A short, collision-resistant continuation id (mirrors loop-state.uid shape). */
function newContinuationId(): string {
  seq += 1;
  return `sub-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/**
 * Persist a child's final transcript and return its continuation id. Evicts the
 * oldest entry when over the cap. A defensive copy is stored so a later mutation
 * of the caller's array can't corrupt the saved transcript.
 */
export function saveContinuation(transcript: readonly ModelMessage[]): string {
  const id = newContinuationId();
  store.set(id, [...transcript]);
  while (store.size > MAX_CONTINUATIONS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return id;
}

/**
 * Load a saved transcript to seed a resumed child, or null if the id is unknown
 * (evicted / wrong conversation / never existed). Returns a defensive copy.
 */
export function loadContinuation(id: string): ModelMessage[] | null {
  const found = store.get(id);
  return found ? [...found] : null;
}

/** Forget every saved continuation — called on conversation reset/resume. */
export function clearContinuations(): void {
  store.clear();
}

/** Test-only: current number of stored continuations. */
export function continuationCount(): number {
  return store.size;
}
