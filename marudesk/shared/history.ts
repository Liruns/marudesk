/**
 * Browsing-history contract. Entries are persisted in main
 * (electron/history.ts) and queried by the address bar for inline
 * autocomplete. A plain serializable record — no live handles.
 */
export type HistoryEntry = {
  url: string;
  title: string;
  /** Times this exact URL was visited (the primary ranking signal). */
  visitCount: number;
  /** Epoch ms of the most recent visit (breaks frecency ties). */
  lastVisit: number;
};

/**
 * Frecency score: visitCount dominates; lastVisit breaks ties (newer ranks
 * higher). Shared by the store's pruning (electron/history.ts) and the
 * suggestion ranker (shared/suggest.ts) so the two orderings can't diverge.
 */
export function frecency(e: HistoryEntry): number {
  return e.visitCount * 1e13 + e.lastVisit;
}

/** `https://www.example.com/x` → `example.com/x` — the form users type. */
export function stripUrlPrefix(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}
