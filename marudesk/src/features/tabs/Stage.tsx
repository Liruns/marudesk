import { useTabsStore } from './store';
import { tabKinds } from './registry';
import { useGridStore, groupForTab } from './grid';
import { GridStage } from './GridStage';
import { SeedDropOverlay } from './SeedDropOverlay';

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
export function Stage() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const groups = useGridStore((s) => s.groups);
  const draggingTabId = useGridStore((s) => s.draggingTabId);

  // The active tab's split group, if any. Persistent groups mean switching tabs
  // just swaps which grid renders (or shows the single view for a standalone
  // tab) — a split is hidden while you're away and restored intact on return,
  // never destroyed. groups empty / standalone tab → the single-view path below.
  const activeLayout = groupForTab(groups, activeTabId);
  if (activeLayout) return <GridStage layout={activeLayout} />;

  const kind = tabs.find((t) => t.id === activeTabId)?.kind ?? 'home';

  // While a *different* tab is dragged from the strip, a drop overlay sits over
  // the single view so dropping it seeds a 2-pane grid (the first split). A split
  // needs two distinct tabs, so we never arm the overlay for the active tab being
  // dragged onto its own stage — that's the "one tab, why does it split?" bug
  // (you'd get a pane tiled with itself). With a single tab open, the only
  // draggable chip is the active one, so the overlay simply never appears.
  const canSeedSplit = !!draggingTabId && draggingTabId !== activeTabId;
  return (
    <div className="flex-1 min-w-0 flex relative">
      {tabKinds[kind].render()}
      {canSeedSplit ? <SeedDropOverlay draggedTabId={draggingTabId!} /> : null}
    </div>
  );
}
