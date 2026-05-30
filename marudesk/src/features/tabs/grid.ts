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
  /**
   * Repoint whatever leaf is bound to `oldId` at `newId`. Used when a tiled tab
   * is replaced in place (browser:tabs-replace mints a new id): without this the
   * leaf would orphan to the now-dead old id and the orphan handler would
   * collapse the pane, discarding the replacement.
   */
  remap: (oldId: string, newId: string) => void;
  focus: (leafId: PaneId) => void;
  /** Mark a tab as being dragged from the strip (null clears it). */
  setDraggingTab: (tabId: string | null) => void;
  /** Leave the grid and return to the single active-tab view. */
  clear: () => void;
};

/**
 * Keep tiled tabs adjacent in the strip so a split reads as one merged group.
 * Reorders the strip so every tab in `layout` sits contiguously (in leaf order)
 * at the slot of the earliest current group member; non-grid tabs keep their
 * relative order. No-op when nothing would move. This is what makes "combine two
 * tabs into a split" also visibly combine them in the top strip.
 */
function syncStripGrouping(layout: LayoutNode): void {
  const tabsState = useTabsStore.getState();
  const all = tabsState.tabs.map((t) => t.id);
  // Dedupe: a pane can be seeded twice with the same tab (dragging the active
  // tab onto its own stage), and duplicate ids would corrupt the reorder list.
  const groupIds = [
    ...new Set(
      leaves(layout)
        .map((l) => l.tabId)
        .filter((id): id is string => !!id && all.includes(id)),
    ),
  ];
  if (groupIds.length < 2) return;
  const groupSet = new Set(groupIds);
  const next: string[] = [];
  let inserted = false;
  for (const id of all) {
    if (groupSet.has(id)) {
      if (!inserted) {
        next.push(...groupIds); // drop the whole group in at the first slot
        inserted = true;
      }
      // other group members are skipped — already placed as a block
    } else {
      next.push(id);
    }
  }
  if (next.some((id, i) => id !== all[i])) tabsState.reorderTabs(next);
}

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
      syncStripGrouping(next);
      return;
    }
    const next = splitLeaf(layout, targetLeafId, dir, newTabId, side);
    // The new leaf is the freshly-created one carrying newTabId; focus it.
    const before = new Set(leaves(layout).map((l) => l.id));
    const fresh = leaves(next).find(
      (l) => !before.has(l.id) && l.tabId === newTabId,
    );
    set({ layout: next, focusedPaneId: fresh?.id ?? get().focusedPaneId });
    syncStripGrouping(next);
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

  remap: (oldId, newId) => {
    const { layout } = get();
    if (!layout) return;
    const leaf = leaves(layout).find((l) => l.tabId === oldId);
    if (!leaf) return;
    set({ layout: setLeafTab(layout, leaf.id, newId) });
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

/**
 * Leave the grid when the active tab is no longer one of the tiled panes — the
 * user clicked a tab outside the split, or opened/created a new one. This keeps
 * the invariant "while gridded, the active tab is a visible pane"; without it,
 * main activates a tab the grid hides, so the click appears to do nothing.
 *
 * Deliberately defers to the orphan handler above while a pane points at a
 * just-closed tab (the collapse is mid-flight) to avoid a close-race flip-flop;
 * closePane sets layout=null before the active id settles, so this then no-ops.
 */
useTabsStore.subscribe((state, prev) => {
  if (state.activeTabId === prev.activeTabId) return;
  const { layout } = useGridStore.getState();
  if (!layout) return;
  const id = state.activeTabId;
  if (!id) return;
  const live = new Set(state.tabs.map((t) => t.id));
  const gridLeaves = leaves(layout).filter((l) => l.tabId);
  if (gridLeaves.some((l) => l.tabId && !live.has(l.tabId))) return; // orphan in flight
  if (!gridLeaves.some((l) => l.tabId === id)) useGridStore.getState().clear();
});
