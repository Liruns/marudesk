import { create } from 'zustand';
import {
  leafLayout,
  leaves,
  removeLeaf,
  setLeafTab,
  setRatio,
  splitLeaf,
  type LayoutNode,
  type PaneId,
  type SplitDir,
} from './layout';
import { useTabsStore } from './store';

/**
 * The tab grid (Phase F). `layout === null` means the grid is OFF and the app
 * shows the single active tab exactly as before (the non-regression baseline);
 * a non-null layout switches the stage to a tiled view of several tabs at once.
 *
 * The tree itself (split/leaf nodes, ratios, rect math) lives in the pure
 * `layout.ts`; this store only owns the *current* tree + which pane is focused,
 * and threads the layout helpers through zustand actions. Dropping a tab onto a
 * pane splits it; closing the last-but-one pane collapses back to the single
 * view (layout = null).
 */

type GridState = {
  layout: LayoutNode | null;
  focusedPaneId: PaneId | null;
  /**
   * The tab id currently being dragged from the strip, or null. Drives the
   * seed-the-grid drop overlay in the single view: while a drag is in flight we
   * surface a drop layer over the stage (and hide the web view) so the first
   * drop can create a 2-pane grid even when a web tab is active.
   */
  draggingTabId: string | null;
};

type GridActions = {
  /**
   * Split a pane to host `newTabId`. With a live layout, splits the leaf
   * `targetLeafId` (`side` picks which side the new pane lands on, `dir` the
   * orientation). With no layout yet (`targetLeafId === null`), seeds a 2-pane
   * grid from the current active tab plus the dragged tab.
   */
  splitWith: (
    targetLeafId: PaneId | null,
    newTabId: string,
    dir: SplitDir,
    side: 'before' | 'after',
  ) => void;
  /** Remove a pane; collapse to the single view when one pane would remain. */
  closePane: (leafId: PaneId) => void;
  resize: (splitId: PaneId, ratio: number) => void;
  assign: (leafId: PaneId, tabId: string | null) => void;
  focus: (leafId: PaneId) => void;
  /** Mark a tab as being dragged from the strip (null clears it). */
  setDraggingTab: (tabId: string | null) => void;
  /** Leave the grid and return to the single active-tab view. */
  clear: () => void;
};

export const useGridStore = create<GridState & GridActions>((set, get) => ({
  layout: null,
  focusedPaneId: null,
  draggingTabId: null,

  splitWith: (targetLeafId, newTabId, dir, side) => {
    const { layout } = get();
    if (!layout || targetLeafId === null) {
      // Seed a fresh 2-pane grid: the current active tab beside the dragged one.
      const activeTabId = useTabsStore.getState().activeTabId;
      const base = leafLayout(activeTabId);
      const next = splitLeaf(base, base.id, dir, newTabId, side);
      const fresh = leaves(next).find((l) => l.tabId === newTabId);
      set({ layout: next, focusedPaneId: fresh?.id ?? base.id });
      return;
    }
    const next = splitLeaf(layout, targetLeafId, dir, newTabId, side);
    // The new leaf is the freshly-created one carrying newTabId; focus it.
    const before = new Set(leaves(layout).map((l) => l.id));
    const fresh = leaves(next).find(
      (l) => !before.has(l.id) && l.tabId === newTabId,
    );
    set({ layout: next, focusedPaneId: fresh?.id ?? get().focusedPaneId });
  },

  closePane: (leafId) => {
    const { layout } = get();
    if (!layout) return;
    const next = removeLeaf(layout, leafId);
    const remaining = leaves(next);

    // Multi-pane path: just update the layout tree, no IPC ordering needed.
    if (remaining.length > 1) {
      set((s) => ({
        layout: next,
        focusedPaneId:
          s.focusedPaneId && remaining.some((l) => l.id === s.focusedPaneId)
            ? s.focusedPaneId
            : (remaining[0]?.id ?? null),
      }));
      return;
    }

    // HIGH-1 + MED-3: collapsing to the single view.
    //
    // Resolve a survivor tab id with a safe fallback chain:
    //   1. The surviving pane's pinned tabId (the common case).
    //   2. The current main-process active tab (still valid mid-collapse).
    //   3. The first live tab in the store (last resort; prevents a blank stage).
    const tabsState = useTabsStore.getState();
    const liveTabs = tabsState.tabs;
    const rawSurvivor = remaining[0]?.tabId ?? null;
    const survivorId =
      (rawSurvivor && liveTabs.some((t) => t.id === rawSurvivor)
        ? rawSurvivor
        : null) ??
      (tabsState.activeTabId &&
      liveTabs.some((t) => t.id === tabsState.activeTabId)
        ? tabsState.activeTabId
        : null) ??
      liveTabs[0]?.id ??
      null;

    // IPC ordering fix: set layout → null only *after* activateTab resolves so
    // that the GridStage unmount (→ browser:clear-pane-bounds →
    // applyBoundsToActive) finds the correct activeTabId already committed in
    // the main process. Without the await the two IPCs can arrive out of order.
    if (survivorId) {
      tabsState.activateTab(survivorId).then(() => {
        set({ layout: null, focusedPaneId: null });
      }).catch(() => {
        // activateTab failed (tab already gone); collapse anyway so the UI
        // doesn't stay stuck in grid mode with a broken pane.
        set({ layout: null, focusedPaneId: null });
      });
    } else {
      // No live tab to activate — collapse immediately; main will open a home
      // tab via its own closeTab fallback if needed.
      set({ layout: null, focusedPaneId: null });
    }
  },

  resize: (splitId, ratio) => {
    const { layout } = get();
    if (!layout) return;
    set({ layout: setRatio(layout, splitId, ratio) });
  },

  assign: (leafId, tabId) => {
    const { layout } = get();
    if (!layout) return;
    set({ layout: setLeafTab(layout, leafId, tabId) });
  },

  focus: (leafId) => set({ focusedPaneId: leafId }),

  setDraggingTab: (tabId) => set({ draggingTabId: tabId }),

  clear: () => set({ layout: null, focusedPaneId: null, draggingTabId: null }),
}));

/**
 * Keep the grid consistent with the open tabs: when a tab closes, drop any pane
 * bound to it (collapsing to the single view if only one pane is left). Mirrors
 * the editor/terminal prune subscriptions — the grid is just another consumer
 * of the live tab set.
 */
useTabsStore.subscribe((state) => {
  const { layout } = useGridStore.getState();
  if (!layout) return;
  const live = new Set(state.tabs.map((t) => t.id));
  const orphan = leaves(layout).find((l) => l.tabId && !live.has(l.tabId));
  if (orphan) useGridStore.getState().closePane(orphan.id);
});
