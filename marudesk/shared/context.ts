import type { ModelMessage } from 'ai';
import type { AgentMessage } from './agent';

/**
 * Shared types for the built-in **Context MCP** (docs/context-mcp-design.md). The
 * AI Chat ships a local MCP server that lets the model pull, on demand, from the
 * app's live surfaces: browser tabs, terminals, the file explorer, DevTools, plus
 * two new persistent stores — previous chat sessions and a memory of notes.
 *
 * Most sources main can read in-process (web tabs, terminals, CDP, the workspace
 * index). The two it can't — **unsaved editor buffers** and the **explorer's tree
 * state** — live in the renderer, so the renderer mirrors them to main on change
 * via `context:sync` (a one-way push; main never round-trips the renderer).
 */

/* ── renderer → main mirror (context:sync) ──────────────────────────────── */

/** One open editor buffer mirrored to main (carries unsaved edits main can't see). */
export type EditorMirror = {
  /** Workspace-relative POSIX path, or `untitled-<tabId>` for a scratch buffer. */
  path: string;
  /** Has unsaved edits (content ≠ last saved). */
  dirty: boolean;
  /** Live buffer text, bounded at sync time. */
  content: string;
  /** True when `content` was clipped before syncing. */
  truncated?: boolean;
};

/** The file-explorer tree state main can't observe (expansion + selection). */
export type ExplorerMirror = {
  root: string | null;
  expandedDirs: string[];
  selectedPath: string | null;
  /** Indexed file count, for a quick "size of the tree" read. */
  fileCount?: number;
};

/** The renderer→main mirror payload pushed (debounced) on store changes. */
export type ContextSyncPayload = {
  editors: EditorMirror[];
  explorer: ExplorerMirror;
};

export function emptyContextSync(): ContextSyncPayload {
  return { editors: [], explorer: { root: null, expandedDirs: [], selectedPath: null } };
}

/* ── sessions (previous chat records) ───────────────────────────────────── */

/** A one-line summary of a saved chat session (the `list_sessions` row shape). */
export type SessionSummary = {
  id: string;
  /** Derived from the first user message. */
  title: string;
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
  messageCount: number;
};

/** A search hit over saved sessions — a summary plus an optional match excerpt. */
export type SessionSearchHit = SessionSummary & {
  /** A short excerpt around the match (FTS snippet), when the backend provides one. */
  snippet?: string;
};

/** Storage stats for the Data & Storage settings panel. */
export type StorageStats = {
  /** Which backend the session store is using right now. */
  backend: 'sqlite' | 'json';
  /** Number of saved AI Chat sessions. */
  sessionCount: number;
  /** Approximate on-disk bytes used by the session store. */
  sessionBytes: number;
};

/** A full saved session — summary + the (display-shaped) transcript. */
export type SessionRecord = SessionSummary & {
  messages: AgentMessage[];
  usage?: { inputTokens: number; outputTokens: number; contextTokens?: number };
  /**
   * The provider-neutral running transcript, so a resumed session can keep
   * talking with full context (display `messages` alone can't reconstruct
   * tool_use/tool_result pairing). main-only — written by the loop's
   * persistSession, ignored by the renderer and the context MCP tools. Absent on
   * sessions saved before this field existed (those resume as read-only history).
   */
  transcript?: ModelMessage[];
};

/* ── memory (persistent notes the AI can read/write) ────────────────────── */

/** A memory entry's metadata (the `list_memory` row shape). */
export type MemoryEntry = {
  /** Stable kebab-case slug / name. */
  name: string;
  updatedAt: number;
  /** First ~120 chars of the body, for the list view. */
  preview: string;
};

/** A memory entry with its full markdown body (the `read_memory` shape). */
export type MemoryEntryFull = MemoryEntry & { body: string };
