import { create } from 'zustand';

/**
 * Which surface the Shell renders. Mission Control (workgraph) is now the ONLY
 * reachable surface (docs/mission-control-redesign.md): the Task graph is the
 * home, with tools opening as instruments. The legacy `canvas` (infinite cards)
 * and `classic` (tab grid) surfaces are retired — their switcher (the ActivityBar
 * menu) is no longer reachable, so `mode` is pinned to `workgraph`.
 *
 * The `SurfaceMode` union and the store API are kept so the few residual readers
 * (the now-unmounted legacy ActivityBar, TabPalette) still compile during the
 * transition; physically deleting those surfaces is the final cleanup pass.
 */
export type SurfaceMode = 'canvas' | 'classic' | 'workgraph';

type SurfaceState = {
  mode: SurfaceMode;
  setMode: (mode: SurfaceMode) => void;
};

export const useSurfaceStore = create<SurfaceState>((set) => ({
  mode: 'workgraph',
  setMode: (mode) => set({ mode }),
}));
