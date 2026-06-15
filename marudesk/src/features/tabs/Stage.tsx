import { useTabsStore } from './store';
import { tabKinds } from './registry';
import { useGridStore, groupForTab } from './grid';
import { GridStage } from './GridStage';
import { EmptyStage } from './EmptyStage';
import { SeedDropOverlay } from './SeedDropOverlay';
import { useCanvasOwnedTabIds } from '../canvas/store';
import type { WorkspaceId } from '../../../shared/workspace';

/**
 * The universal tab container. Picks the stage view for the active tab's kind
 * through the shared `tabKinds` registry:
 *   web      → BrowserCanvas (toolbar + the host's WebContentsView)
 *   home     → HomeView (New Tab dashboard / launcher)
 *   terminal → TerminalView (xterm, lazy)
 *   editor   → EditorView (Monaco, lazy)
 *   settings → SettingsView
 *
 * Only the 'web' kind owns a WebContentsView. The main process hides that view
 * whenever a feature tab is active, so the React surface rendered here shows
 * through unobstructed.
 */
export function Stage({ workspaceId }: { workspaceId?: WorkspaceId } = {}) {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTabIdsByWorkspace = useTabsStore((s) => s.activeTabIdsByWorkspace);
  const groups = useGridStore((s) => s.groups);
  const draggingTabId = useGridStore((s) => s.draggingTabId);
  // Tabs that live on the infinite canvas are owned by that surface; the classic
  // stage hides them so the two surfaces keep separate tab sets.
  const canvasOwned = useCanvasOwnedTabIds();
  const scopedTabs = (workspaceId ? tabs.filter((tab) => tab.workspaceId === workspaceId) : tabs).filter(
    (tab) => !canvasOwned.has(tab.id),
  );
  const preferredActiveTabId = workspaceId
    ? (activeTabIdsByWorkspace[workspaceId] ?? activeTabId)
    : activeTabId;
  const scopedActiveTabId = scopedTabs.some((tab) => tab.id === preferredActiveTabId)
    ? preferredActiveTabId
    : (scopedTabs[0]?.id ?? null);

  // No tabs in this pane's workspace: show the dedicated empty screen (closing the
  // last tab no longer forces a home tab). Distinct from the New Tab dashboard.
  if (scopedTabs.length === 0) return <EmptyStage workspaceId={workspaceId} />;

  // The active tab's split group, if any. Persistent groups mean switching tabs
  // just swaps which grid renders (or shows the single view for a standalone
  // tab) — a split is hidden while you're away and restored intact on return,
  // never destroyed. groups empty / standalone tab → the single-view path below.
  const activeLayout = groupForTab(groups, scopedActiveTabId);
  if (activeLayout) return <GridStage layout={activeLayout} />;

  const activeTab = scopedTabs.find((t) => t.id === scopedActiveTabId);
  const kind = activeTab?.kind ?? 'home';

  // While a *different* tab is dragged from the strip, a drop overlay sits over
  // the single view so dropping it seeds a 2-pane grid (the first split). A split
  // needs two distinct tabs, so we never arm the overlay for the active tab being
  // dragged onto its own stage — that's the "one tab, why does it split?" bug
  // (you'd get a pane tiled with itself). With a single tab open, the only
  // draggable chip is the active one, so the overlay simply never appears.
  const draggedTab = tabs.find((tab) => tab.id === draggingTabId);
  const canSeedSplit =
    !!draggingTabId &&
    draggingTabId !== scopedActiveTabId &&
    (!workspaceId || draggedTab?.workspaceId === workspaceId);
  return (
    <div className="flex-1 min-w-0 flex relative">
      {tabKinds[kind].render(scopedActiveTabId ?? undefined, activeTab)}
      {canSeedSplit && draggingTabId ? (
        <SeedDropOverlay draggedTabId={draggingTabId} />
      ) : null}
    </div>
  );
}
