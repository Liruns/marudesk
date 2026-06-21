import { create } from 'zustand';
import type { TabKind } from '../../../shared/browser';
import { confirmCloseTab } from '../editor/store';
import { useTabsStore } from '../tabs/store';

/**
 * The instrument a Task has summoned into Mission Control's main area
 * (docs/mission-control-redesign.md, Phase 2c). A Task's Resource opens here as a
 * real tool surface (browser / Monaco / terminal) hosted via the tab registry —
 * the live `WebContentsView` paints over the main rect, so the runtime-aware
 * browser gets full real estate ("zoom into the node, the instrument fills the
 * frame"). `null` = no instrument; the graph is the home.
 *
 * The instrument owns exactly ONE tab at a time and is the source of truth for
 * its lifecycle: opening a new one (or closing back to the graph) CLOSES the
 * previous tab so the main process tears down its WebContentsView. Without this
 * the native web view would keep painting over the graph after "← Graph" — there
 * is no other tab switch to hide it (clearBrowserPaneBounds re-reveals whatever
 * tab is still active in main).
 */
type InstrumentState = {
  tabId: string | null;
  kind: TabKind | null;
  open: (tabId: string, kind: TabKind) => void;
  close: () => void;
};

export const useInstrumentStore = create<InstrumentState>((set, get) => ({
  tabId: null,
  kind: null,
  open: (tabId, kind) => {
    const prev = get().tabId;
    if (prev && prev !== tabId) {
      // Close the previous instrument tab so its native view is torn down. Honor
      // the dirty-editor prompt; if the user keeps it, leave it open (its buffer
      // is preserved — no silent data loss) and still switch to the new one.
      const tab = useTabsStore.getState().tabs.find((t) => t.id === prev);
      if (confirmCloseTab(tab)) void useTabsStore.getState().closeTab(prev);
    }
    set({ tabId, kind });
  },
  close: () => {
    const prev = get().tabId;
    if (prev) {
      const tab = useTabsStore.getState().tabs.find((t) => t.id === prev);
      // Cancelling the dirty-editor prompt keeps you on the instrument.
      if (!confirmCloseTab(tab)) return;
      void useTabsStore.getState().closeTab(prev);
    }
    set({ tabId: null, kind: null });
  },
}));

// If an instrument's tab is closed from elsewhere (e.g. Ctrl/Cmd+W while it is the
// active tab), drop the dangling reference so the Shell returns to the graph
// instead of rendering blank instrument chrome over an already-destroyed view.
useTabsStore.subscribe((s) => {
  const id = useInstrumentStore.getState().tabId;
  if (id && !s.tabs.some((t) => t.id === id)) {
    useInstrumentStore.setState({ tabId: null, kind: null });
  }
});
