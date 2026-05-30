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
};

type WebPageActions = {
  setPendingUrl: (url: string) => void;
  commitNavigate: () => Promise<void>;
  toggleInspect: () => Promise<void>;
  setInspect: (on: boolean) => Promise<void>;
  addCapture: (capture: Capture) => void;
  removeCapture: (id: string) => void;
  clearCaptures: () => void;
  toggleCaptureSelected: (id: string) => void;
  setAllSelected: (selected: boolean) => void;
};

export const useWebPageStore = create<WebPageState & WebPageActions>(
  (set, get) => ({
    currentUrl: '',
    pendingUrl: '',
    inspectMode: false,
    captures: [],
    selectedCaptureIds: new Set<string>(),

    setPendingUrl: (pendingUrl) => set({ pendingUrl }),

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
