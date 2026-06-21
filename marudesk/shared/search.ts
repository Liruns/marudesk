/**
 * Types for workspace content search (electron/search.ts ↔
 * src/features/search). The search runs in main against the open workspace
 * root, preferring ripgrep and falling back to a Node walk; these are the
 * sanitized shapes that cross IPC.
 */

import type { WorkspaceId } from './workspace';

/** Search options from the Search panel toggles + glob filters. */
export type SearchOptions = {
  /** Case-sensitive match (default false → case-insensitive). */
  caseSensitive: boolean;
  /** Match whole words only. */
  wholeWord: boolean;
  /** Treat the query as a regular expression (else a literal substring). */
  regex: boolean;
  /**
   * Comma/newline separated globs to restrict the search to (VSCode "files to
   * include"). Empty searches the whole workspace. A pattern without a slash
   * matches a file's basename at any depth (e.g. `*.ts`); one with a slash is
   * anchored to the workspace root (e.g. `src/**`).
   */
  includes: string;
  /** Comma/newline separated globs to exclude (VSCode "files to exclude"). */
  excludes: string;
  /**
   * Scope the search to THIS workspace's active root instead of the global
   * active workspace. Set by a Search instrument bound to a non-active
   * workspace so the listed results and the opened file refs resolve against
   * the same root. Omitted (the legacy rail / coincident active case) searches
   * the active workspace, unchanged.
   */
  workspaceId?: WorkspaceId;
};

/** A match span within a preview line, as 0-based char offsets [start, end). */
export type SearchMatchRange = {
  start: number;
  end: number;
};

/** One match within a file. */
export type SearchMatch = {
  /** 1-based line number. */
  line: number;
  /** 1-based column of the (first) match start. */
  col: number;
  /** The left-trimmed, length-capped line text for preview. */
  preview: string;
  /**
   * Match spans within `preview` (0-based char offsets), so the panel can
   * highlight them. Ranges are already adjusted for the preview's trimming and
   * length cap; spans pushed past the cap are dropped.
   */
  ranges: SearchMatchRange[];
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
