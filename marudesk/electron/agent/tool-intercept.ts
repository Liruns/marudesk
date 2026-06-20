/**
 * Per-tool-call intercept seam (SECOND-PASS "Per-tool-call intercept seam").
 *
 * HOOK-1 ({@link ./before-turn.ts}) contributes system-prompt text ONCE per turn.
 * This is its per-tool-call twin: a tiny, priority-ordered registry of FIRST-PARTY
 * hooks that wrap a single tool dispatch. The loop calls {@link runBeforeToolCall}
 * just before it dispatches a CLEARED call (after approval/deny gating) and
 * {@link runAfterToolCall} just after the executor returns, so a hook can:
 *
 *   - observe a call (audit log) without changing it,
 *   - BLOCK a call with a reason (returns a synthetic error result instead of
 *     dispatching) — gating already happened, this is an extra overlay,
 *   - rewrite/annotate a result (attach a verify-note at the right granularity).
 *
 * v1 ships with an EMPTY registry — no hook is registered — so with nothing
 * registered the dispatch path is byte-for-byte identical to today: before-hooks
 * return undefined (no block) and after-hooks return the result unchanged. This is
 * a pure seam, not a behavior change, and deliberately NOT a user-pluggable hook
 * framework (no 54-slot anything).
 *
 * Dependency-free on purpose: no Electron / ipc imports, so it loads under the
 * plain `--experimental-strip-types` harnesses (no loader hook). Any relative
 * value imports must use an explicit `.ts` extension for the same reason. The
 * meta/result shapes below are structural duplicates of the loop's narrow needs,
 * kept here so this module imports no runtime code.
 *
 * Module-level state is process-global (a single Electron main process). Long-
 * lived first-party registrations persist across conversation reset / thread
 * switch; do NOT assume per-turn or per-thread isolation.
 */

/**
 * Narrow, READ-ONLY snapshot of the call a hook may inspect. The input is the
 * model-supplied tool arguments (already JSON-parsed by the loop). Treat it as
 * immutable — to change behavior, return a block (before) or a rewrite (after).
 */
export type ToolCallMeta = Readonly<{
  /** The tool's registered name, e.g. 'edit_file'. */
  name: string;
  /** The parsed tool input arguments. */
  input: unknown;
  /** Absolute root of the active workspace, or null for a folderless chat. */
  ws: string | null;
  /** The provider driving this turn (e.g. 'anthropic', 'openai'). */
  provider: string;
  /** The concrete model id driving this turn. */
  modelId: string;
}>;

/**
 * The minimal result shape an after-hook sees and may rewrite. A structural
 * subset of the loop's ToolResult (summary + text + isError) — the only fields a
 * result-annotating hook needs. The loop maps this back onto the full result.
 */
export type ToolCallResult = Readonly<{
  summary: string;
  text: string;
  isError?: boolean;
}>;

/** A before-hook's decision to block a call: a synthetic error result is returned. */
export type ToolCallBlock = Readonly<{
  /** Why the call was blocked — surfaced to the model as the tool_result text. */
  reason: string;
}>;

/** Relative priority band; a higher band runs before a lower one. */
export type ToolInterceptPriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * Fixed execution order. Within a band, registration order is preserved (stable
 * sort), so a hook registered earlier at the same priority runs first.
 */
export const INTERCEPT_PRIORITY_ORDER: readonly ToolInterceptPriority[] = [
  'critical',
  'high',
  'normal',
  'low',
];

/**
 * A before-tool-call hook. Return a {@link ToolCallBlock} to STOP the dispatch
 * (the call is answered with a synthetic error carrying the reason), or
 * null/undefined to allow it. May be async. The FIRST hook to return a block
 * wins — later hooks do not run for that call.
 */
export type BeforeToolCallHook = (
  meta: ToolCallMeta,
) => Promise<ToolCallBlock | null | undefined> | ToolCallBlock | null | undefined;

/**
 * An after-tool-call hook. Return a rewritten {@link ToolCallResult} to replace
 * the result the model sees, or null/undefined to leave it unchanged. Each hook
 * receives the PREVIOUS hook's output (results chain), so annotations compose.
 * May be async.
 */
export type AfterToolCallHook = (
  meta: ToolCallMeta,
  result: ToolCallResult,
) => Promise<ToolCallResult | null | undefined> | ToolCallResult | null | undefined;

type BeforeRegistration = {
  readonly priority: ToolInterceptPriority;
  readonly fn: BeforeToolCallHook;
};
type AfterRegistration = {
  readonly priority: ToolInterceptPriority;
  readonly fn: AfterToolCallHook;
};

/** Module-level registries — process-global; see file header on lifetime. */
const beforeRegistry: BeforeRegistration[] = [];
const afterRegistry: AfterRegistration[] = [];

const priorityRank = (p: ToolInterceptPriority): number => INTERCEPT_PRIORITY_ORDER.indexOf(p);

/**
 * Register a before-tool-call hook at the given priority. Returns an unregister
 * function that splices exactly this registration back out. Idempotent: calling
 * the unregister twice is safe.
 */
export function registerBeforeToolCall(
  priority: ToolInterceptPriority,
  fn: BeforeToolCallHook,
): () => void {
  const entry: BeforeRegistration = { priority, fn };
  beforeRegistry.push(entry);
  return () => {
    const i = beforeRegistry.indexOf(entry);
    if (i !== -1) beforeRegistry.splice(i, 1);
  };
}

/**
 * Register an after-tool-call hook at the given priority. Returns an unregister
 * function (same semantics as {@link registerBeforeToolCall}).
 */
export function registerAfterToolCall(
  priority: ToolInterceptPriority,
  fn: AfterToolCallHook,
): () => void {
  const entry: AfterRegistration = { priority, fn };
  afterRegistry.push(entry);
  return () => {
    const i = afterRegistry.indexOf(entry);
    if (i !== -1) afterRegistry.splice(i, 1);
  };
}

/** Stable sort by priority band, preserving same-band registration order. */
function ordered<T extends { priority: ToolInterceptPriority }>(registry: readonly T[]): T[] {
  return [...registry].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
}

/**
 * Run the before-hooks for a cleared call. Returns the FIRST block a hook asks
 * for (and stops), or null when every hook allows the call. With an empty
 * registry this is `null` — the loop dispatches exactly as before.
 *
 * Each hook runs inside its own try/catch so one that throws is non-fatal — it is
 * skipped (treated as "allow") and the rest still run. An empty/whitespace-only
 * reason is treated as no block (a hook must give a real reason to stop a call).
 */
export async function runBeforeToolCall(meta: ToolCallMeta): Promise<ToolCallBlock | null> {
  for (const entry of ordered(beforeRegistry)) {
    let decision: ToolCallBlock | null | undefined;
    try {
      decision = await entry.fn(meta);
    } catch {
      continue;
    }
    if (decision && typeof decision.reason === 'string' && decision.reason.trim()) {
      return { reason: decision.reason.trim() };
    }
  }
  return null;
}

/**
 * Run the after-hooks for a settled call, threading the result through each hook
 * so annotations compose (hook N sees hook N-1's output). Returns the final
 * (possibly rewritten) result. With an empty registry this returns the input
 * result unchanged.
 *
 * Each hook runs inside its own try/catch so one that throws is non-fatal — its
 * rewrite is skipped and the chain continues with the prior result. A hook that
 * returns null/undefined leaves the result unchanged; a returned object must have
 * string `summary` + `text` to be accepted.
 */
export async function runAfterToolCall(
  meta: ToolCallMeta,
  result: ToolCallResult,
): Promise<ToolCallResult> {
  let current = result;
  for (const entry of ordered(afterRegistry)) {
    let next: ToolCallResult | null | undefined;
    try {
      next = await entry.fn(meta, current);
    } catch {
      continue;
    }
    if (next && typeof next.summary === 'string' && typeof next.text === 'string') {
      current = { summary: next.summary, text: next.text, ...(next.isError ? { isError: true } : {}) };
    }
  }
  return current;
}

/** Test/teardown only: drop every registration. Not used in production. */
export function __clearToolInterceptRegistries(): void {
  beforeRegistry.length = 0;
  afterRegistry.length = 0;
}
