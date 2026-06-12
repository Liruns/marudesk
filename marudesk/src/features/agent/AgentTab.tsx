import { useEffect, useRef } from 'react';
import { AgentChat } from './AgentChat';
import { SessionRail } from './SessionRail';
import { AgentScopeProvider, getAgentStoreForWorkspace } from './store';
import type { WorkspaceId } from '../../../shared/workspace';
import { useTabsStore } from '../tabs/store';

/**
 * The full-surface AI Chat — the `agent` tab kind (v3 §5-B, Antigravity/Claude/
 * Codex Desktop parity). Hosts {@link AgentChat} in its wide, centered `full`
 * variant. Each tab auto-creates its own thread so multiple AI Chat tabs in the
 * same workspace keep separate conversations and independent input state.
 */
export function AgentTab({ tabId, workspaceId }: { tabId?: string; workspaceId?: WorkspaceId }) {
  const threadRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!tabId) return;

    let cancelled = false;
    void (async () => {
      try {
        const threads = await window.marudesk.invoke('agent:new-thread', { workspaceId });
        if (cancelled) return;
        const active = (threads as { id: string; active: boolean }[]).find((t) => t.active);
        if (active) {
          threadRef.current = active.id;
          getAgentStoreForWorkspace(workspaceId).getState().setActiveThreadId(active.id);
        }
      } catch {
        // best-effort — falls back to the workspace's current active thread
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      // Close the tab's thread when unmounting (tab close). Silently fails if
      // it's the last thread in the workspace (main refuses to close the last one).
      if (threadRef.current) {
        void window.marudesk.invoke('agent:close-thread', {
          id: threadRef.current,
          workspaceId,
        }).catch(() => {});
      }
    };
  }, [tabId, workspaceId]);

  // When this tab becomes the active tab, switch to its thread.
  useEffect(() => {
    if (!tabId) return;
    return useTabsStore.subscribe((state) => {
      if (state.activeTabId === tabId && threadRef.current) {
        void window.marudesk.invoke('agent:switch-thread', {
          id: threadRef.current,
          workspaceId,
        }).then((threads) => {
          const active = (threads as { id: string; active: boolean }[]).find((t) => t.active);
          if (active) {
            getAgentStoreForWorkspace(workspaceId).getState().setActiveThreadId(active.id);
          }
        }).catch(() => {});
      }
    });
  }, [tabId, workspaceId]);

  return (
    <AgentScopeProvider workspaceId={workspaceId}>
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
