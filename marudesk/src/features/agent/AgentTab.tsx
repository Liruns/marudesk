import { useEffect, useState } from 'react';
import { Spinner } from '../../components/ui';
import { AgentChat } from './AgentChat';
import { SessionRail } from './SessionRail';
import { AgentScopeProvider, getAgentStoreForWorkspace } from './store';
import { acquireCardThread } from './cardThreads';
import type { WorkspaceId } from '../../../shared/workspace';
import { useTabsStore } from '../tabs/store';

/**
 * The full-surface AI Chat — the `agent` tab kind. Hosts {@link AgentChat} in its
 * wide `full` variant. Each tab owns its own conversation thread (via
 * {@link acquireCardThread}, reused across remounts so a workspace/surface switch
 * never loses the conversation).
 *
 * **Per-tab isolation:** every AI Chat tab BINDS to its own thread
 * (`AgentScopeProvider threadId`) regardless of surface — classic OR canvas. A
 * bound scope resolves a thread-scoped store + a thread-filtered live stream
 * (`agent:thread-event`), so two AI Chat tabs never share a transcript: opening a
 * new chat in another tab is a fresh conversation, and switching back restores
 * each tab's own state. (Previously classic tabs left the thread unbound and all
 * shared the one workspace store — the "every AI Chat shows the same screen" bug.)
 */
export function AgentTab({ tabId, workspaceId }: { tabId?: string; workspaceId?: WorkspaceId }) {
  const [threadId, setThreadId] = useState<string | null>(null);

  // Acquire (once) this tab's thread; kept alive across remounts by the registry,
  // closed only when the tab itself closes.
  useEffect(() => {
    if (!tabId) return;
    let cancelled = false;
    void acquireCardThread(tabId, workspaceId).then((id) => {
      if (cancelled || !id) return;
      setThreadId(id);
      getAgentStoreForWorkspace(workspaceId).getState().setActiveThreadId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [tabId, workspaceId]);

  // When this tab becomes active, point the workspace's active thread at it so the
  // classic single-view + workspace-scoped store follow. Canvas cards bind to
  // their own thread directly, so this only matters off-canvas.
  useEffect(() => {
    if (!tabId || !threadId) return;
    return useTabsStore.subscribe((state) => {
      if (state.activeTabId !== tabId) return;
      void window.marudesk
        .invoke('agent:switch-thread', { id: threadId, workspaceId })
        .then((threads) => {
          const active = (threads as { id: string; active: boolean }[]).find((t) => t.active);
          if (active) getAgentStoreForWorkspace(workspaceId).getState().setActiveThreadId(active.id);
        })
        .catch(() => {});
    });
  }, [tabId, workspaceId, threadId]);

  // Bind to this tab's own thread in BOTH surfaces so each AI Chat tab is an
  // independent conversation. Wait for the thread before mounting the chat so a
  // tab never briefly shows another thread's transcript on first open.
  const boundThreadId = threadId ?? undefined;
  const waiting = !!tabId && !threadId;

  return (
    <AgentScopeProvider workspaceId={workspaceId} threadId={boundThreadId}>
      {/* @container: the chat surface adapts to its PANE width — children use
          @[…rem]: variants. */}
      <div className="flex-1 min-w-0 flex flex-row min-h-0 bg-surface-page @container">
        {waiting ? (
          <div className="flex-1 min-w-0 min-h-0 grid place-items-center bg-surface-page">
            <Spinner size={18} />
          </div>
        ) : (
          <>
            <SessionRail />
            <div className="flex-1 min-w-0 flex flex-col min-h-0">
              <AgentChat variant="full" />
            </div>
          </>
        )}
      </div>
    </AgentScopeProvider>
  );
}
