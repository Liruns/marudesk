import { create } from 'zustand';

/**
 * Which surface the Shell renders in its stage region: the infinite **canvas**
 * (Maru's default) or the **classic** tab-strip + split-grid. Persisted to
 * localStorage so the choice sticks across launches; both modes share the same
 * chrome (activity bar, side panels, status bar, tab strip) — only the centre
 * swaps. Tests seed `maru.surface=classic` so the classic-shell specs are
 * unaffected by the canvas default (see e2e/helpers/app.ts).
 */
export type SurfaceMode = 'canvas' | 'classic';

const KEY = 'maru.surface';

function load(): SurfaceMode {
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(KEY);
      if (v === 'classic' || v === 'canvas') return v;
    }
  } catch {
    // ignore storage failures — fall through to the default
  }
  return 'canvas';
}

type SurfaceState = {
  mode: SurfaceMode;
  setMode: (mode: SurfaceMode) => void;
  toggle: () => void;
};

export const useSurfaceStore = create<SurfaceState>((set, get) => ({
  mode: load(),
  setMode: (mode) => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, mode);
    } catch {
      // best-effort persistence
    }
    set({ mode });
  },
  toggle: () => get().setMode(get().mode === 'canvas' ? 'classic' : 'canvas'),
}));
