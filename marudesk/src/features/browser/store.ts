import { create } from 'zustand';
import type { Capture } from '../../../shared/capture';
import { useTabsStore } from '../tabs/store';

/**
 * The web-page surface store (concern B of the old fused browser store). Owns
 * everything specific to the embedded web view: the address bar (currentUrl /
 * pendingUrl), inspect mode, and the element captures that feed the composer.
 * Consumed by the browser canvas, the pane omnibox, and the context/composer
 * surfaces.
 *
 * It may depend on the tab registry (`features/tabs/store.ts`) but not the other
 * way around — see the address-bar subscription at the bottom of this file.
 */

type WebPageState = {
  currentUrl: string;
  pendingUrl: string;
  inspectMode: boolean;
  captures: Capture[];
  selectedCaptureIds: Set<string>;
  /**
   * Monotonic counter bumped to request that the address bar focus + select
   * itself (Ctrl/Cmd+L). The canvas watches it in an effect; a counter (not a
   * boolean) so a repeat press re-focuses even if nothing else changed.
   */
  addressBarFocusNonce: number;
  // In-page find (Ctrl+F). `findMatches`/`findActiveMatch` are pushed from main
  // via browser:found-in-page; `findFocusNonce` re-focuses the find input the
  // same way addressBarFocusNonce does for the address bar.
  findOpen: boolean;
  findQuery: string;
  findMatches: number;
  findActiveMatch: number;
  findFocusNonce: number;
};

type WebPageActions = {
  setPendingUrl: (url: string) => void;
  commitNavigate: () => Promise<void>;
  toggleInspect: () => Promise<void>;
  setInspect: (on: boolean) => Promise<void>;
  addCapture: (capture: Capture) => void;
  removeCapture: (id: string) => void;
  /** Set (or clear) the user's note on a capture (v6 §U2). */
  setCaptureComment: (id: string, comment: string) => void;
  clearCaptures: () => void;
  toggleCaptureSelected: (id: string) => void;
  setAllSelected: (selected: boolean) => void;
  focusAddressBar: () => void;
  // find
  openFind: () => void;
  closeFind: () => void;
  setFindQuery: (query: string) => void;
  findNext: (forward: boolean) => void;
  setFindResult: (matches: number, activeMatch: number) => void;
  reissueFind: () => void;
};

export const useWebPageStore = create<WebPageState & WebPageActions>(
  (set, get) => ({
    currentUrl: '',
    pendingUrl: '',
    inspectMode: false,
    captures: [],
    selectedCaptureIds: new Set<string>(),
    addressBarFocusNonce: 0,
    findOpen: false,
    findQuery: '',
    findMatches: 0,
    findActiveMatch: 0,
    findFocusNonce: 0,

    setPendingUrl: (pendingUrl) => set({ pendingUrl }),

    focusAddressBar: () =>
      set((s) => ({ addressBarFocusNonce: s.addressBarFocusNonce + 1 })),

    /* ── in-page find ─────────────────────────────────────────────────── */

    openFind: () => {
      // Bumping the focus nonce re-focuses the input even when the bar is
      // already open (e.g. a second Ctrl+F from the page). Re-issue the search
      // on reopen so highlights return without the user retyping.
      set((s) => ({ findOpen: true, findFocusNonce: s.findFocusNonce + 1 }));
      const { findQuery } = get();
      if (findQuery) {
        void window.marudesk.invoke('browser:find', {
          text: findQuery,
          findNext: false,
        });
      }
    },

    closeFind: () => {
      void window.marudesk.invoke('browser:stop-find', 'clearSelection');
      set({ findOpen: false, findMatches: 0, findActiveMatch: 0 });
    },

    setFindQuery: (query) => {
      set({ findQuery: query });
      if (query) {
        // findNext:false = a fresh search (re-highlight all, jump to first).
        void window.marudesk.invoke('browser:find', { text: query, findNext: false });
      } else {
        void window.marudesk.invoke('browser:stop-find', 'clearSelection');
        set({ findMatches: 0, findActiveMatch: 0 });
      }
    },

    findNext: (forward) => {
      const { findQuery } = get();
      if (!findQuery) return;
      void window.marudesk.invoke('browser:find', {
        text: findQuery,
        findNext: true,
        forward,
      });
    },

    setFindResult: (matches, activeMatch) =>
      set({ findMatches: matches, findActiveMatch: activeMatch }),

    // Re-run the current query (fresh search) — used after a navigation drops
    // Chromium's find session, so the bar's count doesn't go stale.
    reissueFind: () => {
      const { findOpen, findQuery } = get();
      if (findOpen && findQuery) {
        void window.marudesk.invoke('browser:find', {
          text: findQuery,
          findNext: false,
        });
      }
    },

    commitNavigate: async () => {
      const { pendingUrl } = get();
      const url = pendingUrl.trim();
      if (!url) return;
      await window.marudesk.invoke('browser:navigate', url);
      set({ currentUrl: url });
    },

    toggleInspect: async () => {
      const next = !get().inspectMode;
      await window.marudesk.invoke('browser:set-inspect-mode', next);
      set({ inspectMode: next });
    },

    setInspect: async (on) => {
      if (get().inspectMode === on) return;
      await window.marudesk.invoke('browser:set-inspect-mode', on);
      set({ inspectMode: on });
    },

    addCapture: (capture) =>
      set((state) => {
        const selectedCaptureIds = new Set(state.selectedCaptureIds);
        selectedCaptureIds.add(capture.id);
        return {
          captures: [capture, ...state.captures],
          selectedCaptureIds,
        };
      }),

    removeCapture: (id) =>
      set((state) => {
        const selectedCaptureIds = new Set(state.selectedCaptureIds);
        selectedCaptureIds.delete(id);
        return {
          captures: state.captures.filter((c) => c.id !== id),
          selectedCaptureIds,
        };
      }),

    setCaptureComment: (id, comment) =>
      set((state) => {
        const trimmed = comment.trim();
        return {
          captures: state.captures.map((c) =>
            c.id === id ? { ...c, comment: trimmed ? trimmed : undefined } : c,
          ),
        };
      }),

    clearCaptures: () =>
      set({ captures: [], selectedCaptureIds: new Set<string>() }),

    toggleCaptureSelected: (id) =>
      set((state) => {
        const selectedCaptureIds = new Set(state.selectedCaptureIds);
        if (selectedCaptureIds.has(id)) {
          selectedCaptureIds.delete(id);
        } else {
          selectedCaptureIds.add(id);
        }
        return { selectedCaptureIds };
      }),

    setAllSelected: (selected) =>
      set((state) => ({
        selectedCaptureIds: selected
          ? new Set(state.captures.map((c) => c.id))
          : new Set<string>(),
      })),
  }),
);

/**
 * Keep the address bar in sync with the active tab's live navigation. `nav`
 * lives in the tab registry (it's pushed per active tab); the address bar is a
 * web-surface concern, so it's derived here instead of fusing the two stores.
 *
 * The rule is the old `setNavState`'s: adopt the new live URL, but don't clobber
 * what the user is typing — `pendingUrl` only follows when it still matches the
 * last committed URL (or is empty), i.e. the user isn't mid-edit. Guarding on
 * the `nav` reference means we ignore unrelated tab-registry changes (tab list,
 * active id) and react only when a fresh nav snapshot arrives.
 */
useTabsStore.subscribe((state, prev) => {
  if (state.nav === prev.nav) return;
  const navUrl = state.nav.url;
  useWebPageStore.setState((web) => ({
    currentUrl: navUrl || web.currentUrl,
    pendingUrl:
      web.pendingUrl === web.currentUrl || web.pendingUrl === ''
        ? navUrl
        : web.pendingUrl,
  }));
});

/**
 * Reset the find bar on a tab switch. The bar is shared and bound to the active
 * web tab, so carrying its matches/query onto a different page would be stale.
 * (The previous tab keeps its native highlights until it navigates or find runs
 * there again — a minor, acceptable artifact for v1.)
 */
useTabsStore.subscribe((state, prev) => {
  if (state.activeTabId === prev.activeTabId) return;
  const web = useWebPageStore.getState();
  if (web.findOpen || web.findMatches || web.findQuery) {
    useWebPageStore.setState({
      findOpen: false,
      findQuery: '',
      findMatches: 0,
      findActiveMatch: 0,
    });
  }
});
