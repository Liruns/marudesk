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
 * The tab grid (Phase F → **persistent split groups**). A "split" used to be one
 * app-global layout: switching to any tab outside it cleared the layout, so
 * coming back showed a single pane — the split had been destroyed, not hidden.
 *
 * Now each split is an independent, persistent GROUP (its own pane tree). A tab
 * belongs to at most one group; the *active* group is derived from the active tab
 * (`groupForTab`). Switching tabs therefore just changes which group renders —
 * other groups' trees are never touched — so a split survives visiting another
 * tab and coming back. This is the Chrome/Edge/Arc split-view model (a split is a
 * persistent thing in the tab strip, not transient view state). `groups` empty =
 * no split anywhere → the single active-tab view.
 *
 * The tree math (split/leaf nodes, ratios, rects) lives in pure `layout.ts`; this
 * store owns the list of group trees + which pane is focused. The main process is
 * unchanged: it just positions web views to whatever pane rects the renderer
 * reports for the active group (electron/browser/layout.ts).
 */

type GridState = {
  /** Independent split-pane trees; a tab is in at most one. Empty = no split. */
  groups: LayoutNode[];
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
   * Split a pane to host `newTabId`. With `targetLeafId` set, splits that leaf
   * inside its group (`side` picks which side the new pane lands on, `dir` the
   * orientation). With `targetLeafId === null`, seeds a fresh 2-pane group from
   * the current active tab plus the dragged tab.
   */
  splitWith: (
    targetLeafId: PaneId | null,
    newTabId: string,
    dir: SplitDir,
    side: 'before' | 'after',
  ) => void;
  /** Remove a pane; dissolve its group back to a single tab when one would remain. */
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
  /** Dissolve the split group containing `tabId` (the strip's "exit split"). */
  dissolveGroup: (tabId: string) => void;
};

/** The split group whose leaves include `tabId`, or null if it's standalone. */
export function groupForTab(
  groups: LayoutNode[],
  tabId: string | null,
): LayoutNode | null {
  if (!tabId) return null;
  return groups.find((g) => leaves(g).some((l) => l.tabId === tabId)) ?? null;
}

/** The group whose tree contains the leaf `leafId`, by reference. */
function findGroupByLeaf(groups: LayoutNode[], leafId: PaneId): LayoutNode | undefined {
  return groups.find((g) => leaves(g).some((l) => l.id === leafId));
}

/** Replace a group (by reference) with `next`; drop it when `next` is null. */
function replaceGroup(
  groups: LayoutNode[],
  prev: LayoutNode,
  next: LayoutNode | null,
): LayoutNode[] {
  const out: LayoutNode[] = [];
  for (const g of groups) {
    if (g === prev) {
      if (next) out.push(next);
    } else {
      out.push(g);
    }
  }
  return out;
}

/**
 * Keep a group's tiled tabs adjacent in the strip so a split reads as one merged
 * block. Reorders the strip so every tab in `group` sits contiguously (leaf
 * order) at the slot of the earliest current member; non-members keep their
 * relative order. No-op when nothing would move. This is what makes "combine two
 * tabs into a split" also visibly merge them in the top strip — and, because the
 * group persists, the merge persists across tab switches too.
 */
function syncStripGrouping(group: LayoutNode): void {
  const tabsState = useTabsStore.getState();
  const all = tabsState.tabs.map((t) => t.id);
  // Dedupe: a pane can be seeded twice with the same tab (dragging the active
  // tab onto its own stage), and duplicate ids would corrupt the reorder list.
  const groupIds = [
    ...new Set(
      leaves(group)
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
  groups: [],
  focusedPaneId: null,
  draggingTabId: null,

  splitWith: (targetLeafId, newTabId, dir, side) => {
    const { groups, focusedPaneId } = get();
    if (targetLeafId === null) {
      // Seed a fresh 2-pane group: the current active tab beside the dragged one.
      // The seed overlay only appears in the single view, so the active tab is
      // standalone here; if it somehow already belongs to a group, split that
      // group's leaf instead of minting a duplicate.
      const activeTabId = useTabsStore.getState().activeTabId;
      const existing = groupForTab(groups, activeTabId);
      if (existing) {
        const leaf = leaves(existing).find((l) => l.tabId === activeTabId);
        if (!leaf) return;
        const next = splitLeaf(existing, leaf.id, dir, newTabId, side);
        const fresh = leaves(next).find((l) => l.tabId === newTabId);
        set({ groups: replaceGroup(groups, existing, next), focusedPaneId: fresh?.id ?? focusedPaneId });
        syncStripGrouping(next);
        return;
      }
      const base = leafLayout(activeTabId);
      const next = splitLeaf(base, base.id, dir, newTabId, side);
      const fresh = leaves(next).find((l) => l.tabId === newTabId);
      set({ groups: [...groups, next], focusedPaneId: fresh?.id ?? base.id });
      syncStripGrouping(next);
      return;
    }
    const group = findGroupByLeaf(groups, targetLeafId);
    if (!group) return;
    const next = splitLeaf(group, targetLeafId, dir, newTabId, side);
    // The new leaf is the freshly-created one carrying newTabId; focus it.
    const before = new Set(leaves(group).map((l) => l.id));
    const fresh = leaves(next).find(
      (l) => !before.has(l.id) && l.tabId === newTabId,
    );
    set({ groups: replaceGroup(groups, group, next), focusedPaneId: fresh?.id ?? focusedPaneId });
    syncStripGrouping(next);
  },

  closePane: (leafId) => {
    const { groups, focusedPaneId } = get();
    const group = findGroupByLeaf(groups, leafId);
    if (!group) return;
    const next = removeLeaf(group, leafId);
    const remaining = leaves(next);

    // Multi-pane path: just update the group's tree, no IPC ordering needed.
    if (remaining.length > 1) {
      set({
        groups: replaceGroup(groups, group, next),
        focusedPaneId:
          focusedPaneId && remaining.some((l) => l.id === focusedPaneId)
            ? focusedPaneId
            : (remaining[0]?.id ?? null),
      });
      return;
    }

    // Collapse this group to a single survivor → dissolve the group; the survivor
    // becomes a standalone tab (Chrome/Edge: "close one side → the other returns
    // to a normal tab"). Resolve a survivor with a safe fallback chain:
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

    const without = replaceGroup(groups, group, null);

    // IPC ordering: activate the survivor BEFORE dropping the group so that, when
    // the group's GridStage unmounts (→ browser:clear-pane-bounds →
    // applyBoundsToActive), the correct activeTabId is already committed in main.
    // Without the await the two IPCs can arrive out of order (the old single-view
    // collapse bug). If there's nothing to activate, just drop the group.
    if (survivorId) {
      tabsState
        .activateTab(survivorId)
        .then(() => set({ groups: without, focusedPaneId: null }))
        .catch(() => set({ groups: without, focusedPaneId: null }));
    } else {
      set({ groups: without, focusedPaneId: null });
    }
  },

  resize: (splitId, ratio) => {
    // Dividers only render in the active group, so resize targets it.
    const { groups } = get();
    const activeTabId = useTabsStore.getState().activeTabId;
    const group = groupForTab(groups, activeTabId);
    if (!group) return;
    set({ groups: replaceGroup(groups, group, setRatio(group, splitId, ratio)) });
  },

  assign: (leafId, tabId) => {
    const { groups } = get();
    const group = findGroupByLeaf(groups, leafId);
    if (!group) return;
    set({ groups: replaceGroup(groups, group, setLeafTab(group, leafId, tabId)) });
  },

  remap: (oldId, newId) => {
    const { groups } = get();
    const group = groups.find((g) => leaves(g).some((l) => l.tabId === oldId));
    if (!group) return;
    const leaf = leaves(group).find((l) => l.tabId === oldId);
    if (!leaf) return;
    set({ groups: replaceGroup(groups, group, setLeafTab(group, leaf.id, newId)) });
  },

  focus: (leafId) => set({ focusedPaneId: leafId }),

  setDraggingTab: (tabId) => set({ draggingTabId: tabId }),

  dissolveGroup: (tabId) => {
    const { groups, focusedPaneId } = get();
    const group = groupForTab(groups, tabId);
    if (!group) return;
    const focusedInGroup =
      !!focusedPaneId && leaves(group).some((l) => l.id === focusedPaneId);
    set({
      groups: replaceGroup(groups, group, null),
      focusedPaneId: focusedInGroup ? null : focusedPaneId,
    });
  },
}));

/**
 * Keep the groups consistent with the open tabs: when a tab closes, drop any pane
 * bound to it (dissolving the group to a single tab if only one pane is left).
 * Mirrors the editor/terminal prune subscriptions — the grid is just another
 * consumer of the live tab set. A closed tab is in at most one group, so one
 * closePane per change suffices.
 */
useTabsStore.subscribe((state) => {
  const { groups } = useGridStore.getState();
  if (groups.length === 0) return;
  const live = new Set(state.tabs.map((t) => t.id));
  for (const g of groups) {
    const orphan = leaves(g).find((l) => l.tabId && !live.has(l.tabId));
    if (orphan) {
      useGridStore.getState().closePane(orphan.id);
      return;
    }
  }
});

// NB: there is deliberately NO "clear the grid when the active tab leaves it"
// subscription anymore. That was the persistence bug — activating a tab outside
// the split destroyed the layout. With per-tab groups, switching tabs simply
// re-derives which group renders (Stage uses groupForTab), so a split is hidden
// while you're away and restored intact when you return.
