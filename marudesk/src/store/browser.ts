import { create } from 'zustand';
import type { Capture } from '../types/capture';

type BrowserState = {
  currentUrl: string;
  pendingUrl: string;
  inspectMode: boolean;
  captures: Capture[];
};

type BrowserActions = {
  setPendingUrl: (url: string) => void;
  commitNavigate: () => Promise<void>;
  toggleInspect: () => Promise<void>;
  setInspect: (on: boolean) => Promise<void>;
  addCapture: (capture: Capture) => void;
  removeCapture: (id: string) => void;
  clearCaptures: () => void;
};

export const useBrowserStore = create<BrowserState & BrowserActions>((set, get) => ({
  currentUrl: '',
  pendingUrl: '',
  inspectMode: false,
  captures: [],

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
    set((state) => ({ captures: [capture, ...state.captures] })),

  removeCapture: (id) =>
    set((state) => ({ captures: state.captures.filter((c) => c.id !== id) })),

  clearCaptures: () => set({ captures: [] }),
}));
