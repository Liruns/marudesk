import { create } from 'zustand';

/**
 * Which surface the Shell renders in its stage region:
 *  - **canvas**    — Maru's infinite canvas of tool cards (the historic default).
 *  - **classic**   — the classic tab-strip + split-grid IDE.
 *  - **workgraph** — the **AI Work OS**: a goal decomposed into a Task graph on
 *    its own plane, with tools opening in a sibling dock rather than inside nodes
 *    (docs/ai-work-os-roadmap.md §3/§7-1). This is the product spine; canvas and
 *    classic remain as alternative layouts behind the surface switcher.
 *
 * Persisted to localStorage so the choice sticks across launches; every mode
 * shares the same chrome (activity bar, side panels, status bar) — only the
 * centre stage swaps. Tests seed `maru.surface` so each surface's specs are
 * isolated (see e2e/helpers/app.ts).
 */
export type SurfaceMode = 'canvas' | 'classic' | 'workgraph';

const KEY = 'maru.surface';
const MODES: readonly SurfaceMode[] = ['canvas', 'classic', 'workgraph'];

function isMode(v: unknown): v is SurfaceMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

function load(): SurfaceMode {
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(KEY);
      if (isMode(v)) return v;
    }
  } catch {
    // ignore storage failures — fall through to the default
  }
  return 'canvas';
}

type SurfaceState = {
  mode: SurfaceMode;
  setMode: (mode: SurfaceMode) => void;
  /** Back-compat flip between canvas and classic (workgraph is picked explicitly). */
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
