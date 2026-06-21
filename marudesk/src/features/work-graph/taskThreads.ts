import type { WorkspaceId } from '../../../shared/workspace';
import { useWorkGraphStore } from './store';

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
  const existing = byTask.get(taskId);
  if (existing) return existing.threadId;
  const inFlight = pending.get(taskId);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      const threads = await window.marudesk.invoke('agent:new-thread', { workspaceId });
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
}

// Close a task's thread only when the task itself is removed from the graph — not
// on deselect/remount. Guarded against a null graph (a transient clear/reload)
// so a live conversation is never torn down by a momentary empty state.
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
