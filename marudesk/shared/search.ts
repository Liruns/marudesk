/**
 * Types for workspace content search (electron/search.ts ↔
 * src/features/search). The search runs in main against the open workspace
 * root, preferring ripgrep and falling back to a Node walk; these are the
 * sanitized shapes that cross IPC.
 */

/** Search options from the Search panel toggles. */
export type SearchOptions = {
  /** Case-sensitive match (default false → case-insensitive). */
  caseSensitive: boolean;
  /** Match whole words only. */
  wholeWord: boolean;
  /** Treat the query as a regular expression (else a literal substring). */
  regex: boolean;
};

/** One match within a file. */
export type SearchMatch = {
  /** 1-based line number. */
  line: number;
  /** 1-based column of the match start. */
  col: number;
  /** The full (trimmed-to-limit) line text for preview. */
  preview: string;
};

/** Matches grouped under one file (workspace-relative POSIX path). */
export type SearchFileResult = {
  path: string;
  matches: SearchMatch[];
};

/**
 * Result of `search:content`. `truncated` is set when the total match cap was
 * hit so the UI can say "showing the first N". `engine` reports which backend
 * served the search (ripgrep when present, else the Node fallback).
 */
export type SearchResult = {
  files: SearchFileResult[];
  truncated: boolean;
  engine: 'ripgrep' | 'node';
};
