import { create } from 'zustand';
import type { TabKind } from '../../../shared/browser';

/**
 * The instrument a Task has summoned into Mission Control's main area
 * (docs/mission-control-redesign.md, Phase 2c). A Task's Resource opens here as a
 * real tool surface (browser / Monaco / terminal) hosted via the tab registry —
 * the live `WebContentsView` paints over the main rect, so the runtime-aware
 * browser gets full real estate ("zoom into the node, the instrument fills the
 * frame"). `null` = no instrument; the graph is the home.
 */
type InstrumentState = {
  tabId: string | null;
  kind: TabKind | null;
  open: (tabId: string, kind: TabKind) => void;
  close: () => void;
};

export const useInstrumentStore = create<InstrumentState>((set) => ({
  tabId: null,
  kind: null,
  open: (tabId, kind) => set({ tabId, kind }),
  close: () => set({ tabId: null, kind: null }),
}));
