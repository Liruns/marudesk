/**
 * Before-turn contributor seam (HOOK-1, docs/agent-port-plan.md).
 *
 * A minimal, priority-ordered registry of FIRST-PARTY hooks that may contribute
 * extra system-prompt text once, just before the turn's system prompt is
 * assembled. The loop calls {@link runBeforeTurnContributors} and splices the
 * returned strings into the system-prompt join between the user's standing
 * instructions and the plan addendum (trust ordering preserved).
 *
 * v1 ships with an EMPTY registry — the existing nine prompt layers are NOT
 * re-registered as contributors — so with no contributor registered the
 * assembled system string is byte-for-byte identical to today. This is a pure
 * seam, not a behavior change, and deliberately NOT a user-pluggable hook
 * framework.
 *
 * Dependency-free on purpose: no Electron / ipc imports, so it loads under the
 * plain `--experimental-strip-types` harnesses (no loader hook). Any relative
 * value imports must use an explicit `.ts` extension for the same reason.
 *
 * Module-level state is process-global (a single Electron main process). Long-
 * lived first-party registrations persist across conversation reset / thread
 * switch; do NOT assume per-turn or per-thread isolation.
 */

/**
 * Narrow, READ-ONLY snapshot handed to each contributor — only what the call
 * site can cheaply supply. Contributors must treat it as immutable.
 */
export type BeforeTurnMeta = Readonly<{
  /** Absolute root of the active workspace, or null for a folderless chat. */
  ws: string | null;
  /** How much the agent may do without asking (Settings → Agent). */
  approvalMode: string;
  /** The provider driving this turn (e.g. 'anthropic', 'openai'). */
  provider: string;
  /** The concrete model id driving this turn. */
  modelId: string;
}>;

/** Relative priority band; a higher band runs before a lower one. */
export type BeforeTurnPriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * Fixed execution order. Within a band, registration order is preserved (stable
 * sort), so a contributor registered earlier at the same priority runs first.
 */
export const PRIORITY_ORDER: readonly BeforeTurnPriority[] = ['critical', 'high', 'normal', 'low'];

/**
 * A before-turn contributor. Returns the system-prompt text to fold in, or
 * null/undefined (and empty/whitespace-only strings are also dropped) to
 * contribute nothing. May be async.
 */
export type BeforeTurnContributor = (meta: BeforeTurnMeta) => Promise<string | null | undefined>;

type Registration = {
  readonly priority: BeforeTurnPriority;
  readonly fn: BeforeTurnContributor;
};

/** Module-level registry — process-global; see file header on lifetime. */
const registry: Registration[] = [];

const priorityRank = (p: BeforeTurnPriority): number => PRIORITY_ORDER.indexOf(p);

/**
 * Register a before-turn contributor at the given priority. Returns an
 * unregister function that splices exactly this registration back out (later
 * runs no longer invoke it). Idempotent: calling the unregister twice is safe.
 */
export function registerBeforeTurnContributor(
  priority: BeforeTurnPriority,
  fn: BeforeTurnContributor,
): () => void {
  const entry: Registration = { priority, fn };
  registry.push(entry);
  return () => {
    const i = registry.indexOf(entry);
    if (i !== -1) registry.splice(i, 1);
  };
}

/**
 * Run every registered contributor for this turn and collect their non-empty
 * contributions, ordered by priority band then registration order.
 *
 * Each contributor runs inside its own try/catch so one that throws is
 * non-fatal — it is skipped and the rest still run. Returned strings are
 * trimmed; null/undefined/empty/whitespace-only results contribute nothing.
 */
export async function runBeforeTurnContributors(meta: BeforeTurnMeta): Promise<string[]> {
  // Stable sort: a band-preserving comparator keeps same-priority registration
  // order (Array.prototype.sort is stable in modern V8/Node).
  const ordered = [...registry].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  const out: string[] = [];
  for (const entry of ordered) {
    try {
      const text = await entry.fn(meta);
      if (typeof text === 'string') {
        const trimmed = text.trim();
        if (trimmed) out.push(trimmed);
      }
    } catch {
      // One throwing contributor must not abort the turn or the other
      // contributors — swallow and continue.
    }
  }
  return out;
}
