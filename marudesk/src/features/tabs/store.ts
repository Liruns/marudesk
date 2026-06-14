import { create } from 'zustand';
import {
  ZERO_NAV,
  applyReorder,
  type NavState,
  type TabGroup,
  type TabGroupColor,
  type TabKind,
  type TabState,
  type TabsSnapshot,
} from '../../../shared/browser';
import {
  applyScopedOrder,
  moveTabAmongGroups,
} from '../../../shared/tab-groups';
import type { WorkspaceId } from '../../../shared/workspace';

/**
 * The tab registry + navigation store (concern A of the old fused browser
 * store). Owns the live tab list, which tab is active, and the active web tab's
 * navigation snapshot, plus the actions that drive the main-process tab map
 * (open / close / activate / reorder) and web navigation (back / forward /
 * reload). ~20 consumers across every feature read from here.
 *
 * This store must NOT import the web-page store (`features/browser/store.ts`):
 * the dependency only runs the other way (the web-page store derives its address
 * bar from `nav` here). Keeping it one-directional is what lets the registry sit
 * underneath every feature without a cycle.
 */

type TabsState = {
  nav: NavState;
  tabs: TabState[];
  activeTabId: string | null;
  activeTabIdsByWorkspace: Record<WorkspaceId, string>;
  /**
   * Chrome-style tab groups, mirrored from main exactly like `tabs`: main owns
   * the records (electron/browser/state.ts) and every group mutation pushes a
   * fresh {@link TabsSnapshot} through `browser:tabs-state`. Distinct from the
   * grid store's split-view groups (`features/tabs/grid.ts`).
   */
  groups: TabGroup[];
};

type TabsActions = {
  setNavState: (state: NavState) => void;
  setTabsState: (snapshot: TabsSnapshot) => void;
  /**
   * Open a new tab and resolve with its id (the id minted by main —
   * `browser:tabs-new` returns it). Callers that need to act on the new tab
   * (e.g. the canvas positioning a fresh card) MUST use this id rather than
   * reading `activeTabId` back: the authoritative `browser:tabs-state` push is
   * coalesced to the next tick, so right after this resolves the store is still
   * stale. Returns null only if main returned no id.
   */
  newTab: (
    kind?: TabKind,
    url?: string,
    workspaceId?: WorkspaceId,
    extra?: { terminalProfile?: 'agent-cli' },
  ) => Promise<string | null>;
  /** Open a plugin's sandboxed UI panel in a new tab (v2 — §8.5). */
  openPluginPanel: (pluginId: string, entry: string) => Promise<void>;
  /**
   * Convert an existing tab into another kind in place (keeps its strip slot).
   * The New Tab page uses this so a launcher click / URL entry replaces the home
   * tab instead of opening a second tab beside it. Resolves with the new tab id
   * (or null if the target vanished) so a caller can repoint a grid pane.
   */
  replaceTab: (
    id: string,
    kind?: TabKind,
    url?: string,
    workspaceId?: WorkspaceId,
  ) => Promise<string | null>;
  closeTab: (id: string) => Promise<void>;
  /** Reopen the most recently closed tab (Ctrl/Cmd+Shift+T). No-op if none. */
  reopenClosedTab: () => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  refreshTabsSnapshot: () => Promise<void>;
  reorderTabs: (orderedIds: string[]) => void;
  /**
   * Drag-reorder one tab to the slot of `targetId` with Chrome-style tab-group
   * membership semantics (dropping inside a group's span joins it; dragging a
   * member out leaves it). The strip's drag-drop uses this; `reorderTabs`
   * stays membership-neutral for bulk callers (grid pane sync).
   */
  moveTab: (id: string, targetId: string) => void;
  /** Create a new tab group containing exactly this tab ("Add to new group"). */
  createTabGroup: (tabId: string) => Promise<string | null>;
  /** Add a tab to an existing group (moves it to the end of the group's span). */
  addTabToTabGroup: (tabId: string, groupId: string) => Promise<void>;
  /** Remove a tab from its group (re-slots just after the group's span). */
  removeTabFromTabGroup: (tabId: string) => Promise<void>;
  /** Rename and/or recolor a group ('' name = unnamed, dot-only chip). */
  updateTabGroup: (
    groupId: string,
    patch: { name?: string; color?: TabGroupColor },
  ) => Promise<void>;
  /** Collapse/expand a group. Main refuses a collapse that would hide every tab. */
  setTabGroupCollapsed: (groupId: string, collapsed: boolean) => Promise<void>;
  /** Ungroup: members stay open in place, the group record goes. */
  dissolveTabGroup: (groupId: string) => Promise<void>;
  /** Close every member tab, then the group itself. */
  closeTabGroup: (groupId: string) => Promise<void>;
  /** Open a fresh home tab directly inside an existing group. */
  newTabInTabGroup: (groupId: string, workspaceId?: WorkspaceId) => Promise<void>;
  /** Pin/unpin a tab (favicon-only, kept at the front). Main re-sorts + pushes. */
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  reloadOrStop: () => Promise<void>;
  reload: (ignoreCache?: boolean) => Promise<void>;
  zoom: (direction: 'in' | 'out' | 'reset') => Promise<void>;
};

function activeTabsByWorkspace(
  tabs: readonly TabState[],
  activeTabId: string | null,
  previous: Record<WorkspaceId, string>,
): Record<WorkspaceId, string> {
  const byId = new Map(tabs.map((tab) => [tab.id, tab] as const));
  const next: Record<WorkspaceId, string> = {};

  for (const [workspaceId, tabId] of Object.entries(previous)) {
    const tab = byId.get(tabId);
    if (tab?.workspaceId === workspaceId) next[workspaceId] = tabId;
  }

  const activeTab = activeTabId ? byId.get(activeTabId) : undefined;
  if (activeTab) next[activeTab.workspaceId] = activeTab.id;

  for (const tab of tabs) {
    if (!next[tab.workspaceId]) next[tab.workspaceId] = tab.id;
  }

  return next;
}

export const useTabsStore = create<TabsState & TabsActions>((set, get) => ({
  nav: ZERO_NAV,
  tabs: [],
  activeTabId: null,
  activeTabIdsByWorkspace: {},
  groups: [],

  // Just record the active tab's nav snapshot. The address bar (currentUrl /
  // pendingUrl) used to be reconciled here too; that now lives in the web-page
  // store, which subscribes to this `nav` and re-derives the bar — so this store
  // never has to know the web surface exists.
  setNavState: (nav) => set({ nav }),

  setTabsState: (snap) =>
    set((state) => ({
      tabs: snap.tabs,
      activeTabId: snap.activeTabId,
      groups: snap.groups,
      activeTabIdsByWorkspace: activeTabsByWorkspace(
        snap.tabs,
        snap.activeTabId,
        state.activeTabIdsByWorkspace,
      ),
    })),

  newTab: async (kind = 'home', url, workspaceId, extra) => {
    const payload = {
      kind,
      ...(url === undefined ? {} : { url }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(extra?.terminalProfile ? { terminalProfile: extra.terminalProfile } : {}),
    };
    const id = await window.marudesk.invoke('browser:tabs-new', payload);
    return typeof id === 'string' ? id : null;
  },

  openPluginPanel: async (pluginId, entry) => {
    await window.marudesk.invoke('browser:tabs-new', {
      kind: 'plugin',
      pluginPanel: { id: pluginId, entry },
    });
  },

  replaceTab: async (id, kind = 'home', url, workspaceId) => {
    const payload = {
      id,
      kind,
      ...(url === undefined ? {} : { url }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    };
    return await window.marudesk.invoke('browser:tabs-replace', payload);
  },

  closeTab: async (id) => {
    await window.marudesk.invoke('browser:tabs-close', id);
  },

  reopenClosedTab: async () => {
    await window.marudesk.invoke('browser:tabs-reopen');
  },

  activateTab: async (id) => {
    const tab = get().tabs.find((entry) => entry.id === id);
    if (tab) {
      set((state) => ({
        activeTabIdsByWorkspace: {
          ...state.activeTabIdsByWorkspace,
          [tab.workspaceId]: id,
        },
      }));
    }
    await window.marudesk.invoke('browser:tabs-activate', id);
  },

  refreshTabsSnapshot: async () => {
    const snap = await window.marudesk.invoke(
      'browser:tabs-snapshot',
    );
    set((state) => ({
      tabs: snap.tabs,
      activeTabId: snap.activeTabId,
      groups: snap.groups,
      activeTabIdsByWorkspace: activeTabsByWorkspace(
        snap.tabs,
        snap.activeTabId,
        state.activeTabIdsByWorkspace,
      ),
    }));
  },

  reorderTabs: (orderedIds) => {
    // Optimistic local reorder; the main process applies the same shared
    // `applyReorder` policy and pushes back a matching snapshot, so the two
    // can't diverge.
    set((state) => {
      const byId = new Map(state.tabs.map((t) => [t.id, t] as const));
      const order = applyReorder(
        state.tabs.map((t) => t.id),
        orderedIds,
      );
      const next = order
        .map((id) => byId.get(id))
        .filter((t): t is TabState => !!t);
      return { tabs: next };
    });
    void window.marudesk.invoke('browser:tabs-reorder', orderedIds);
  },

  moveTab: (id, targetId) => {
    // Optimistic local move with the same shared group-membership policy main
    // applies (moveTabAmongGroups + applyScopedOrder), so the strip doesn't
    // flicker; main pushes back the authoritative snapshot either way.
    set((state) => {
      const moved = state.tabs.find((t) => t.id === id);
      const target = state.tabs.find((t) => t.id === targetId);
      if (!moved || !target || moved.workspaceId !== target.workspaceId) {
        return {};
      }
      const entries = state.tabs
        .filter((t) => t.workspaceId === moved.workspaceId)
        .map((t) => ({ id: t.id, groupId: t.groupId ?? null }));
      let next = moveTabAmongGroups(entries, id, targetId);
      if (moved.pinned) {
        // Pinned tabs never join groups; main clears this the same way.
        next = next.map((e) => (e.id === id ? { id: e.id, groupId: null } : e));
      }
      const membership = new Map(next.map((e) => [e.id, e.groupId] as const));
      const order = applyScopedOrder(
        state.tabs.map((t) => t.id),
        next.map((e) => e.id),
      );
      const byId = new Map(state.tabs.map((t) => [t.id, t] as const));
      const tabs: TabState[] = [];
      for (const tabId of order) {
        const tab = byId.get(tabId);
        if (!tab) continue;
        if (!membership.has(tabId)) {
          tabs.push(tab);
          continue;
        }
        const groupId = membership.get(tabId) ?? null;
        tabs.push(
          groupId === (tab.groupId ?? null)
            ? tab
            : { ...tab, groupId: groupId ?? undefined },
        );
      }
      return { tabs };
    });
    void window.marudesk.invoke('browser:tabs-move', { id, targetId });
  },

  // Tab-group verbs: main owns the group records and pushes a fresh snapshot
  // after every mutation, so nothing is set locally.
  createTabGroup: async (tabId) => {
    return await window.marudesk.invoke('browser:tab-groups-create', { tabId });
  },

  addTabToTabGroup: async (tabId, groupId) => {
    await window.marudesk.invoke('browser:tab-groups-add-tab', { tabId, groupId });
  },

  removeTabFromTabGroup: async (tabId) => {
    await window.marudesk.invoke('browser:tab-groups-remove-tab', { tabId });
  },

  updateTabGroup: async (groupId, patch) => {
    await window.marudesk.invoke('browser:tab-groups-update', {
      groupId,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.color === undefined ? {} : { color: patch.color }),
    });
  },

  setTabGroupCollapsed: async (groupId, collapsed) => {
    await window.marudesk.invoke('browser:tab-groups-collapse', {
      groupId,
      collapsed,
    });
  },

  dissolveTabGroup: async (groupId) => {
    await window.marudesk.invoke('browser:tab-groups-dissolve', { groupId });
  },

  closeTabGroup: async (groupId) => {
    await window.marudesk.invoke('browser:tab-groups-close', { groupId });
  },

  newTabInTabGroup: async (groupId, workspaceId) => {
    const tabId = await window.marudesk.invoke('browser:tabs-new', {
      kind: 'home',
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    await window.marudesk.invoke('browser:tab-groups-add-tab', { tabId, groupId });
  },

  // Pin/unpin: main owns the pinned-first ordering and pushes a fresh snapshot,
  // so there's nothing to set locally.
  setPinned: async (id, pinned) => {
    await window.marudesk.invoke('browser:tabs-set-pinned', { id, pinned });
  },

  goBack: async () => {
    await window.marudesk.invoke('browser:go-back');
  },

  goForward: async () => {
    await window.marudesk.invoke('browser:go-forward');
  },

  reloadOrStop: async () => {
    const { nav } = get();
    if (nav.isLoading) {
      await window.marudesk.invoke('browser:stop');
    } else {
      await window.marudesk.invoke('browser:reload');
    }
  },

  // Unconditional reload (the Ctrl+R / F5 path), independent of the loading
  // state the toolbar's reloadOrStop toggles on. `ignoreCache` = hard reload.
  reload: async (ignoreCache) => {
    await window.marudesk.invoke('browser:reload', ignoreCache);
  },

  // Page zoom (Ctrl +/-/0). The resulting factor flows back through NavState, so
  // there's nothing to set locally — the toolbar reads nav.zoomFactor.
  zoom: async (direction) => {
    await window.marudesk.invoke('browser:zoom', { direction });
  },
}));

/**
 * Subscribe to the set of open tabs of a given kind, firing `onChange` with
 * their live keys only when that set actually changes. Lets feature surfaces
 * (editor buffers, terminal sessions) prune what closed without each
 * re-rolling the store-subscribe + change-guard. `keyOf` should be unique per
 * tab (editor uses filePath ?? untitled-<id>, terminal uses the tab id); the
 * length-prefixed change key still catches a membership change if it isn't.
 */
export function subscribeTabsByKind(
  kind: TabKind,
  keyOf: (tab: TabState) => string,
  onChange: (liveKeys: Set<string>) => void,
): () => void {
  let lastKey = '';
  return useTabsStore.subscribe((state) => {
    const keys = state.tabs.filter((t) => t.kind === kind).map(keyOf);
    const joined = `${keys.length}\n${keys.join('\n')}`;
    if (joined === lastKey) return;
    lastKey = joined;
    onChange(new Set(keys));
  });
}
