import { useEffect } from 'react';
import { AgentChat } from './AgentChat';
import { SessionRail } from './SessionRail';
import {
  AgentScopeProvider,
  disposeAgentPanelStore,
  getAgentPanelStore,
  peekAgentPanelStore,
} from './store';
import type { ThreadSummary } from '../../../shared/agent';
import type { WorkspaceId } from '../../../shared/workspace';
import { useTabsStore } from '../tabs/store';

/**
 * The full-surface AI Chat — the `agent` tab kind (v3 §5-B, Antigravity/Claude/
 * Codex Desktop parity). Hosts {@link AgentChat} in its wide, centered `full`
 * variant. Each tab owns its own conversation thread AND its own panel-scoped
 * store (keyed by tab id), so multiple AI Chat tabs in the same workspace keep
 * separate transcripts, drafts, and history selection — whether they're viewed
 * one at a time (tab switching) or side by side (split panes).
 *
 * Thread lifecycle binds to the TAB, not this component: the single-view stage
 * unmounts the surface on every tab switch, so unmount must NOT close the
 * thread. The panel store keeps the tab→thread binding across remounts, and the
 * module-level watcher below closes the thread when the tab itself closes
 * (including tabs closed while their surface is unmounted).
 */

/** tabId → workspaceId for every agent tab seen, so the close watcher can clean up. */
const agentTabWorkspaces = new Map<string, WorkspaceId | undefined>();

/** In-flight thread setup per tab — a double mount must not create two threads. */
const ensureInFlight = new Map<string, Promise<void>>();

useTabsStore.subscribe((state) => {
  for (const [tabId, workspaceId] of [...agentTabWorkspaces]) {
    if (state.tabs.some((t) => t.id === tabId)) continue;
    agentTabWorkspaces.delete(tabId);
    const threadId = peekAgentPanelStore(workspaceId, tabId)?.getState().activeThreadId;
    disposeAgentPanelStore(workspaceId, tabId);
    // Silently fails if it's the last thread in the workspace (main refuses to
    // close the last one).
    if (threadId) {
      void window.marudesk
        .invoke('agent:close-thread', { id: threadId, workspaceId })
        .catch(() => {});
    }
  }
});

/**
 * Bind the panel to a conversation thread: reuse the thread it already owns
 * (remount after a tab switch) or create a fresh one, then hydrate the panel
 * store so the surface catches up on whatever happened while unmounted.
 */
async function ensurePanelThread(
  tabId: string,
  workspaceId: WorkspaceId | undefined,
): Promise<void> {
  const store = getAgentPanelStore(workspaceId, tabId);
  try {
    const bound = store.getState().activeThreadId;
    if (bound) {
      const threads = await window.marudesk.invoke('agent:list-threads', { workspaceId });
      if (threads.some((t) => t.id === bound)) {
        // Still alive — make it the workspace's active thread again so
        // active-follower surfaces (drawer, bridge) track the visible panel.
        await window.marudesk.invoke('agent:switch-thread', { id: bound, workspaceId });
        return;
      }
    }
    const threads = await window.marudesk.invoke('agent:new-thread', { workspaceId });
    const active = (threads as ThreadSummary[]).find((t) => t.active);
    if (active) store.getState().setActiveThreadId(active.id);
  } catch {
    // best-effort — the panel stays on its empty state until a bind succeeds
  } finally {
    void store.getState().hydrate();
  }
}

export function AgentTab({ tabId, workspaceId }: { tabId?: string; workspaceId?: WorkspaceId }) {
  useEffect(() => {
    if (!tabId) return;
    agentTabWorkspaces.set(tabId, workspaceId);
    if (!ensureInFlight.has(tabId)) {
      ensureInFlight.set(
        tabId,
        ensurePanelThread(tabId, workspaceId).finally(() => ensureInFlight.delete(tabId)),
      );
    }
  }, [tabId, workspaceId]);

  // When this tab becomes the active tab, make its thread the workspace-active
  // one (drawer/bridge follow it). The panel's own binding never changes here.
  useEffect(() => {
    if (!tabId) return;
    let prevActive = useTabsStore.getState().activeTabId;
    return useTabsStore.subscribe((state) => {
      if (state.activeTabId === prevActive) return;
      prevActive = state.activeTabId;
      if (state.activeTabId !== tabId) return;
      const threadId = getAgentPanelStore(workspaceId, tabId).getState().activeThreadId;
      if (!threadId) return;
      void window.marudesk
        .invoke('agent:switch-thread', { id: threadId, workspaceId })
        .catch(() => {});
    });
  }, [tabId, workspaceId]);

  return (
    <AgentScopeProvider workspaceId={workspaceId} panelKey={tabId}>
      {/* @container: the chat surface adapts to its PANE width (split view /
          divider drags), not the viewport — children use @[…rem]: variants. */}
      <div className="flex-1 min-w-0 flex flex-row min-h-0 bg-surface-page @container">
        <SessionRail />
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <AgentChat variant="full" />
        </div>
      </div>
    </AgentScopeProvider>
  );
}
