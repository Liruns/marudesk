import { create } from 'zustand';
import type { Diagnostic, DiagnosticsState } from '../../../shared/diagnostics';
import { toMessage } from '../../lib/toMessage';

/**
 * Renderer mirror of the main-owned diagnostics state (docs/workspace-language-
 * support-design.md, Tier 1). Main runs the project's own checker and pushes the
 * parsed findings on `diagnostics:update`; this store ingests them so the
 * StatusBar indicator and the Monaco markers (features/diagnostics/markers.ts)
 * reproject. `run` triggers a fresh pass (user-initiated, like a build button).
 */

type DiagnosticsStoreState = {
  readonly state: DiagnosticsState;
  readonly error: string | null;
};

type DiagnosticsStoreActions = {
  readonly ingest: (state: DiagnosticsState) => void;
  /** Pull the cached state for the current workspace (initial render / switch). */
  readonly refresh: () => Promise<void>;
  /** Run the project's checker now and store the result. */
  readonly run: () => Promise<void>;
};

const EMPTY: DiagnosticsState = {
  root: null,
  running: false,
  lastRun: null,
  live: [],
  lspServers: [],
};

export const useDiagnosticsStore = create<DiagnosticsStoreState & DiagnosticsStoreActions>(
  (set) => ({
    state: EMPTY,
    error: null,
    ingest: (state) => set({ state }),
    refresh: async () => {
      try {
        set({ state: await window.marudesk.invoke('diagnostics:get'), error: null });
      } catch {
        // No workspace open (requireWorkspace throws) — reset to empty quietly.
        set({ state: EMPTY });
      }
    },
    run: async () => {
      try {
        set({ state: await window.marudesk.invoke('diagnostics:run'), error: null });
      } catch (err) {
        set({ error: toMessage(err) });
      }
    },
  }),
);

/**
 * All current findings: the batch checker pass (tsc/eslint) merged with live
 * language-server diagnostics (Tier 2). Consumers (squiggles, Problems popover,
 * counts) use this so both sources show up uniformly.
 */
export function currentDiagnostics(state: DiagnosticsState): readonly Diagnostic[] {
  const batch = state.lastRun?.diagnostics ?? [];
  return state.live.length > 0 ? [...batch, ...state.live] : batch;
}

/** Error / warning tallies for the current cached run. */
export function diagnosticCounts(state: DiagnosticsState): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of currentDiagnostics(state)) {
    if (d.severity === 'error') errors += 1;
    else if (d.severity === 'warning') warnings += 1;
  }
  return { errors, warnings };
}
