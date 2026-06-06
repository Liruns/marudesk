import { useEffect } from 'react';
import { useWorkspaceStore } from '../workspace/store';
import { useDiagnosticsStore } from './store';

/**
 * Bridge main's `diagnostics:update` pushes into the diagnostics store, and pull
 * the cached state on mount + whenever the active workspace root changes (so a
 * workspace switch clears stale findings — main returns null for a root that
 * hasn't been checked). Monaco-free, so mounting it in the shell doesn't pull the
 * editor bundle in; the marker layer (markers.ts) loads with the editor surface.
 * Mount once (in the shell).
 */
export function useDiagnosticsEvents(): void {
  useEffect(() => {
    const off = window.marudesk.on('diagnostics:update', (state) => {
      useDiagnosticsStore.getState().ingest(state);
    });
    void useDiagnosticsStore.getState().refresh();
    // Re-pull when the open workspace root changes.
    let lastRoot = useWorkspaceStore.getState().summary?.root ?? null;
    const offWs = useWorkspaceStore.subscribe((s) => {
      const root = s.summary?.root ?? null;
      if (root !== lastRoot) {
        lastRoot = root;
        void useDiagnosticsStore.getState().refresh();
      }
    });
    return () => {
      off();
      offWs();
    };
  }, []);
}
