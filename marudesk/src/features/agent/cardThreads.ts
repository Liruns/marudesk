import type { WorkspaceId } from '../../../shared/workspace';
import { subscribeTabsByKind } from '../tabs/store';

/**
 * Per-tab agent thread registry. Each AI Chat tab owns its own conversation
 * thread so multiple cards run fully independently (live at once on the canvas).
 *
 * Crucially the thread is keyed by TAB id and outlives the AgentTab component:
 * switching workspace/surface unmounts a card but the tab persists, so we must
 * NOT close the thread on unmount — only when the tab itself closes. This mirrors
 * the terminal session registry (features/terminal/session.ts), which keeps the
 * PTY alive across remounts and disposes it on the tab-close prune.
 */

type Bound = { threadId: string; workspaceId?: WorkspaceId };

const byTab = new Map<string, Bound>();
const pending = new Map<string, Promise<string | null>>();

/** Get (creating once) the thread id for an AI Chat tab. Reused across remounts. */
export async function acquireCardThread(
  tabId: string,
  workspaceId?: WorkspaceId,
): Promise<string | null> {
  const existing = byTab.get(tabId);
  if (existing) return existing.threadId;
  const inFlight = pending.get(tabId);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      const threads = await window.marudesk.invoke('agent:new-thread', { workspaceId });
      const active = threads.find((t) => t.active);
      const id = active?.id ?? null;
      if (id) byTab.set(tabId, { threadId: id, workspaceId });
      return id;
    } catch {
      return null;
    } finally {
      pending.delete(tabId);
    }
  })();
  pending.set(tabId, p);
  return p;
}

/** The already-resolved thread for a tab, if any (sync read for routing). */
export function cardThreadId(tabId: string): string | null {
  return byTab.get(tabId)?.threadId ?? null;
}

/** The AI Chat tab a thread is bound to, if any (reverse of {@link cardThreadId}).
 *  Lets a send resolve which canvas card it's running in, to gather connections. */
export function tabForThread(threadId: string): string | null {
  for (const [tabId, bound] of byTab) {
    if (bound.threadId === threadId) return tabId;
  }
  return null;
}

// Close a tab's thread only when the AI Chat tab actually closes (not on a mere
// unmount from a workspace/surface switch). Mirrors the terminal/editor prune.
subscribeTabsByKind(
  'agent',
  (t) => t.id,
  (liveIds) => {
    for (const [tabId, bound] of [...byTab.entries()]) {
      if (liveIds.has(tabId)) continue;
      byTab.delete(tabId);
      void window.marudesk
        .invoke('agent:close-thread', { id: bound.threadId, workspaceId: bound.workspaceId })
        .catch(() => {});
    }
  },
);
