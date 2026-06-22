import { create } from 'zustand';

/**
 * Open/closed state for the two keyboard-first navigation overlays — Quick Open
 * (Ctrl/⌘+P, go to file) and the Tab Palette (Ctrl/⌘+Shift+A, switch tab).
 *
 * They were local `useState` in the Shell, reachable only by their shortcuts. A
 * tiny shared store lets the ⌘K command palette open them too (so the actions are
 * discoverable, not hidden behind a chord), while the Shell stays the single
 * place that renders them.
 */
type OverlayState = {
  quickOpen: boolean;
  tabPalette: boolean;
  showQuickOpen: () => void;
  hideQuickOpen: () => void;
  showTabPalette: () => void;
  hideTabPalette: () => void;
};

export const useOverlayStore = create<OverlayState>((set) => ({
  quickOpen: false,
  tabPalette: false,
  showQuickOpen: () => set({ quickOpen: true }),
  hideQuickOpen: () => set({ quickOpen: false }),
  showTabPalette: () => set({ tabPalette: true }),
  hideTabPalette: () => set({ tabPalette: false }),
}));
