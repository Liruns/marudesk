import type { Task } from '../../../shared/work-os';
import type { WorkspaceId } from '../../../shared/workspace';
import { useWorkGraphStore } from './store';

/**
 * A COMPACT, model-facing grounding preamble for a task's conversation thread,
 * built from the LIVE task. Seeded ONCE as the thread's initial system context
 * (see {@link acquireTaskThread}) so the per-task dock agent talks about *this*
 * task — its title, why it exists, what it's judged against, and the latest
 * result — instead of a generic workspace bot that has to be re-told the task on
 * every thread.
 *
 * Pure + read-only: it never mutates the task and derives only from fields the
 * inspector already shows (title / intent / acceptance / evidence.result), so it
 * can never drift from what the user sees. Acceptance criteria and the latest
 * evidence summary are optional — a freshly-planned task with neither yields a
 * minimal title/intent preamble. Kept short (criteria are one line each, the
 * result is clipped) so it doesn't crowd the system block.
 */
export function taskContextPreamble(task: Task): string {
  const lines: string[] = [
    'You are working on a single task from the Maru work graph. Stay focused on it.',
    '',
    `Task: ${task.title}`,
  ];
  const intent = task.intent.trim();
  if (intent) lines.push(`Intent: ${intent}`);

  const criteria = task.acceptance
    .map((c) => c.text.trim())
    .filter((text) => text.length > 0);
  if (criteria.length > 0) {
    lines.push('Acceptance criteria:');
    for (const text of criteria) lines.push(`- ${text}`);
  }

  const result = task.evidence?.result.trim();
  if (result) {
    const MAX_RESULT = 600;
    const clipped = result.length > MAX_RESULT ? `${result.slice(0, MAX_RESULT)}…` : result;
    lines.push(`Latest result: ${clipped}`);
  }

  return lines.join('\n');
}

/** Read the live task by id from the work-graph store (sync), or null if it's gone. */
function liveTask(taskId: string): Task | null {
  return useWorkGraphStore.getState().graph?.tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * Per-Task agent thread registry (Mission Control Phase 2b). Each Task node on the
 * graph owns its own conversation thread, so selecting a node opens *that task's*
 * chat in the Instrument Dock — "you talk to the task, not a global bot."
 *
 * The thread is keyed by TASK id and reused across re-selection (and across
 * workspace switches — the graph is a single flight, so a node keeps its
 * conversation). It is closed only when the task is removed from the graph, never
 * on a mere deselect/remount. This mirrors the per-tab AI Chat registry
 * (features/agent/cardThreads.ts) and the terminal session registry, which keep
 * the underlying resource alive across remounts and prune it on close.
 */

type Bound = { threadId: string; workspaceId?: WorkspaceId };

const byTask = new Map<string, Bound>();
const pending = new Map<string, Promise<string | null>>();

/** Get (creating once) the agent thread id for a Task. Reused across re-selection. */
export async function acquireTaskThread(
  taskId: string,
  workspaceId?: WorkspaceId,
): Promise<string | null> {
  // Register the remove-from-graph cleanup on first use (see ensureGraphSubscription).
  ensureGraphSubscription();
  const existing = byTask.get(taskId);
  if (existing) return existing.threadId;
  const inFlight = pending.get(taskId);
  if (inFlight) return inFlight;
  // Build the grounding preamble ONCE, here at mint time, from the live task —
  // this branch runs only when no thread exists yet, so a re-selection (which
  // returns the existing thread above) never re-seeds and the reuse contract
  // holds. `seedContext` is optional in the contract, so a missing task (gone
  // from the graph) simply mints a blank thread.
  const task = liveTask(taskId);
  const seedContext = task ? taskContextPreamble(task) : undefined;
  const p = (async () => {
    try {
      const threads = await window.marudesk.invoke('agent:new-thread', {
        workspaceId,
        ...(seedContext ? { seedContext } : {}),
      });
      const active = threads.find((t) => t.active);
      const id = active?.id ?? null;
      if (id) byTask.set(taskId, { threadId: id, workspaceId });
      return id;
    } catch {
      return null;
    } finally {
      pending.delete(taskId);
    }
  })();
  pending.set(taskId, p);
  return p;
}

/** The already-resolved thread for a Task, if any (sync read for routing). */
export function taskThreadId(taskId: string): string | null {
  return byTask.get(taskId)?.threadId ?? null;
}

/**
 * The thread id the Instrument Dock's chat is ACTUALLY rendering right now, or
 * null when the dock is closed. Normally this equals the selected task's own
 * thread, but when {@link acquireTaskThread} fails the dock falls back to the
 * workspace conversation and shows THAT thread instead — so `taskThreadId` would
 * miss it. Shell reads this to suppress the "AI finished" toast for whatever the
 * dock visibly shows, fallback included. Published by the dock's TaskChat.
 */
let dockRenderedThread: string | null = null;

export function setDockRenderedThread(threadId: string | null): void {
  dockRenderedThread = threadId;
}

export function dockRenderedThreadId(): string | null {
  return dockRenderedThread;
}

/**
 * The workspace a Task is bound to (via its conversation thread), if known.
 * `undefined` when the task has no thread yet OR was opened without a workspace
 * (i.e. it targets the active workspace). Used to detect a cross-workspace
 * apply→refresh mismatch in the Source Control handoff.
 */
export function taskThreadWorkspaceId(taskId: string): WorkspaceId | undefined {
  return byTask.get(taskId)?.workspaceId;
}

/** Every task that already owns a conversation thread (for the flight log). */
export function taskThreadEntries(): { taskId: string; threadId: string; workspaceId?: WorkspaceId }[] {
  return [...byTask.entries()].map(([taskId, bound]) => ({
    taskId,
    threadId: bound.threadId,
    workspaceId: bound.workspaceId,
  }));
}

/** Test-only reset of the in-memory registry. */
export function __resetTaskThreadsForTests(): void {
  byTask.clear();
  pending.clear();
  dockRenderedThread = null;
}

// Close a task's thread only when the task itself is removed from the graph — not
// on deselect/remount. Guarded against a null graph (a transient clear/reload)
// so a live conversation is never torn down by a momentary empty state.
//
// Registered LAZILY (on the first acquireTaskThread) rather than at module load:
// work-graph/store.ts imports taskThreadWorkspaceId from this module, so this
// module can be evaluated DURING store.ts's own init (a circular import) — before
// useWorkGraphStore is defined. Deferring the subscription past module evaluation
// avoids dereferencing the not-yet-initialized store; nothing needs cleaning up
// before the first thread is acquired, so first-acquire registration loses nothing.
let graphSubscribed = false;
function ensureGraphSubscription(): void {
  if (graphSubscribed) return;
  graphSubscribed = true;
  useWorkGraphStore.subscribe((state, prev) => {
    const graph = state.graph;
    if (!graph || graph === prev.graph) return;
    const live = new Set(graph.tasks.map((t) => t.id));
    for (const [taskId, bound] of [...byTask.entries()]) {
      if (live.has(taskId)) continue;
      byTask.delete(taskId);
      void window.marudesk
        .invoke('agent:close-thread', { id: bound.threadId, workspaceId: bound.workspaceId })
        .catch(() => {});
    }
  });
}
