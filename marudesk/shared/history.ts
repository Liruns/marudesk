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
