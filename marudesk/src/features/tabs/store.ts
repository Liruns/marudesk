import { create } from 'zustand';
import {
  ZERO_NAV,
  applyReorder,
  type NavState,
  type TabKind,
  type TabState,
  type TabsSnapshot,
} from '../../../shared/browser';

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
};

type TabsActions = {
  setNavState: (state: NavState) => void;
  setTabsState: (snapshot: TabsSnapshot) => void;
  newTab: (kind?: TabKind, url?: string) => Promise<void>;
  /**
   * Convert an existing tab into another kind in place (keeps its strip slot).
   * The New Tab page uses this so a launcher click / URL entry replaces the home
   * tab instead of opening a second tab beside it. Resolves with the new tab id
   * (or null if the target vanished) so a caller can repoint a grid pane.
   */
  replaceTab: (id: string, kind?: TabKind, url?: string) => Promise<string | null>;
  closeTab: (id: string) => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  refreshTabsSnapshot: () => Promise<void>;
  reorderTabs: (orderedIds: string[]) => void;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  reloadOrStop: () => Promise<void>;
  reload: (ignoreCache?: boolean) => Promise<void>;
  zoom: (direction: 'in' | 'out' | 'reset') => Promise<void>;
};

export const useTabsStore = create<TabsState & TabsActions>((set, get) => ({
  nav: ZERO_NAV,
  tabs: [],
  activeTabId: null,

  // Just record the active tab's nav snapshot. The address bar (currentUrl /
  // pendingUrl) used to be reconciled here too; that now lives in the web-page
  // store, which subscribes to this `nav` and re-derives the bar — so this store
  // never has to know the web surface exists.
  setNavState: (nav) => set({ nav }),

  setTabsState: (snap) =>
    set({ tabs: snap.tabs, activeTabId: snap.activeTabId }),

  newTab: async (kind = 'home', url) => {
    await window.marudesk.invoke('browser:tabs-new', { kind, url });
  },

  replaceTab: async (id, kind = 'home', url) => {
    return await window.marudesk.invoke('browser:tabs-replace', {
      id,
      kind,
      url,
    });
  },

  closeTab: async (id) => {
    await window.marudesk.invoke('browser:tabs-close', id);
  },

  activateTab: async (id) => {
    await window.marudesk.invoke('browser:tabs-activate', id);
  },

  refreshTabsSnapshot: async () => {
    const snap = await window.marudesk.invoke(
      'browser:tabs-snapshot',
    );
    set({ tabs: snap.tabs, activeTabId: snap.activeTabId });
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
