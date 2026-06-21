import { create } from 'zustand';
import type { SearchOptions, SearchResult } from '../../../shared/search';
import type { WorkspaceId } from '../../../shared/workspace';
import { toMessage } from '../../lib/toMessage';

/**
 * Content-search panel state. Holds the query + toggles + glob filters + the
 * last result set, plus a `focusNonce` the Shell bumps when Ctrl+Shift+F fires
 * so the panel's input can focus without prop-drilling a ref through the layout.
 * The actual search runs in main (search:content) — this store just drives the
 * UI and tracks in-flight/error state.
 */

/** Boolean toggles (case/word/regex) vs the free-text glob filters. */
type SearchToggleKey = 'caseSensitive' | 'wholeWord' | 'regex';
type SearchFilterKey = 'includes' | 'excludes';

type SearchState = {
  query: string;
  options: SearchOptions;
  result: SearchResult | null;
  loading: boolean;
  error: string | null;
  /** Bumped to request the panel focus its input (Ctrl+Shift+F). */
  focusNonce: number;
  /** Tracks the latest run so a slow earlier search can't overwrite a newer one. */
  runId: number;
};

type SearchActions = {
  setQuery: (q: string) => void;
  toggleOption: (key: SearchToggleKey) => void;
  setFilter: (key: SearchFilterKey, value: string) => void;
  /**
   * Run the search. A bound `workspaceId` scopes both this result list AND
   * (via SearchPanel's WorkspaceFileRef) the opened files to that workspace's
   * active root; omitted searches the global active workspace, unchanged.
   */
  run: (query: string, workspaceId?: WorkspaceId) => Promise<void>;
  clear: () => void;
  requestFocus: () => void;
};

export const useSearchStore = create<SearchState & SearchActions>((set, get) => ({
  query: '',
  options: {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    includes: '',
    excludes: '',
  },
  result: null,
  loading: false,
  error: null,
  focusNonce: 0,
  runId: 0,

  setQuery: (q) => set({ query: q }),

  // Toggles + filters only mutate state; the panel re-runs (debounced) when any
  // option changes, so there's a single search path and no duplicate invokes.
  toggleOption: (key) =>
    set((s) => ({ options: { ...s.options, [key]: !s.options[key] } })),

  setFilter: (key, value) =>
    set((s) => ({ options: { ...s.options, [key]: value } })),

  run: async (query, workspaceId) => {
    const q = query.trim();
    if (q === '') {
      set({ result: null, loading: false, error: null });
      return;
    }
    const runId = get().runId + 1;
    set({ runId, loading: true, error: null });
    try {
      const result = await window.marudesk.invoke('search:content', {
        query: q,
        // Thread the bound workspace (when given) so main scopes results to its
        // root; omitting it leaves the active-workspace opts byte-for-byte.
        opts: workspaceId === undefined
          ? get().options
          : { ...get().options, workspaceId },
      });
      // Drop a stale response (a newer search started while this awaited).
      if (get().runId !== runId) return;
      set({ result, loading: false });
    } catch (err) {
      if (get().runId !== runId) return;
      set({ loading: false, error: toMessage(err), result: null });
    }
  },

  clear: () => set({ query: '', result: null, error: null }),

  requestFocus: () => set((s) => ({ focusNonce: s.focusNonce + 1 })),
}));
