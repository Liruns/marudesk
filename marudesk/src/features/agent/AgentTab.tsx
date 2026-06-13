import { useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { AgentChat } from './AgentChat';
import { SessionRail } from './SessionRail';
import { AgentScopeProvider, getAgentStoreForWorkspace } from './store';
import type { WorkspaceId } from '../../../shared/workspace';
import { useTabsStore } from '../tabs/store';
import { useSurfaceStore } from '../canvas/surface';
import { useCanvasStore } from '../canvas/store';
import { useI18n } from '../../i18n/useI18n';

/**
 * The full-surface AI Chat — the `agent` tab kind (v3 §5-B, Antigravity/Claude/
 * Codex Desktop parity). Hosts {@link AgentChat} in its wide, centered `full`
 * variant. Each tab auto-creates its own thread so multiple AI Chat tabs in the
 * same workspace keep separate conversations and independent input state.
 *
 * **Canvas isolation:** the renderer agent store is per-workspace and main streams
 * only the workspace's *active* thread, so two live chat surfaces mounted at once
 * (which the canvas does — every card renders simultaneously) would share one
 * draft + transcript. On the canvas we therefore mount the live surface for the
 * *focused* card only; the rest show a lightweight preview and go live the moment
 * they're focused (which activates their thread). Classic/grid (one surface shown
 * at a time) is unaffected.
 */
export function AgentTab({ tabId, workspaceId }: { tabId?: string; workspaceId?: WorkspaceId }) {
  const surface = useSurfaceStore((s) => s.mode);
  const focusedTabId = useCanvasStore((s) => s.focusedTabId);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  // Live everywhere except an unfocused canvas card. With nothing focused yet,
  // the active tab's card is live so a freshly opened chat is usable immediately.
  const live =
    surface !== 'canvas' ||
    !tabId ||
    focusedTabId === tabId ||
    (focusedTabId === null && activeTabId === tabId);
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
      {live ? (
        /* @container: the chat surface adapts to its PANE width (split view /
           divider drags), not the viewport — children use @[…rem]: variants. */
        <div className="flex-1 min-w-0 flex flex-row min-h-0 bg-surface-page @container">
          <SessionRail />
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <AgentChat variant="full" />
          </div>
        </div>
      ) : (
        <AgentCardPreview />
      )}
    </AgentScopeProvider>
  );
}

/**
 * Shown for an unfocused AI Chat card on the canvas. A quiet placeholder — the
 * card frame is fully clickable (focusing it mounts the live chat), so this only
 * signals what the card is. Reads no shared chat state, so it can never leak
 * another card's draft or transcript.
 */
function AgentCardPreview() {
  const { t } = useI18n();
  return (
    <div
      className="flex-1 min-w-0 min-h-0 flex flex-col items-center justify-center gap-2 bg-surface-page px-6 text-center select-none"
      title={t('agent.card.previewHint')}
    >
      <span className="grid h-10 w-10 place-items-center rounded-lg bg-accent-subtle text-accent">
        <Sparkles size={18} aria-hidden />
      </span>
      <p className="text-body-sm text-fg-secondary">{t('agent.card.title')}</p>
      <p className="text-caption text-fg-tertiary">{t('agent.card.previewHint')}</p>
    </div>
  );
}
