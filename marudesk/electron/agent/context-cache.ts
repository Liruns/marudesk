import {
  emptyContextSync,
  type ContextSyncPayload,
  type EditorMirror,
  type ExplorerMirror,
} from '../../shared/context';

/**
 * Main-side cache of the renderer's last context mirror (docs/context-mcp-design
 * §3). The agent loop runs in main, but the renderer owns two surfaces main can't
 * observe: unsaved editor buffers and the file-explorer's tree state. The renderer
 * pushes them here (debounced) via the `context:sync` IPC handler whenever they
 * change; the context tools (`read_editor`, `read_explorer`) read this snapshot.
 *
 * One-way and best-effort: a stale or empty cache just means those tools report
 * "nothing mirrored yet" — main never blocks on the renderer.
 */

let cache: ContextSyncPayload = emptyContextSync();
let listener: ((payload: ContextSyncPayload) => void) | null = null;

/**
 * Observe context-mirror updates. The LSP manager (electron/lsp) subscribes to
 * drive document sync (didOpen/didChange/didClose) from the open editor buffers —
 * main already receives them here, so no new renderer path is needed.
 */
export function setContextCacheListener(fn: ((payload: ContextSyncPayload) => void) | null): void {
  listener = fn;
}

export function updateContextCache(payload: ContextSyncPayload): void {
  cache = payload;
  listener?.(payload);
}

export function getContextCache(): ContextSyncPayload {
  return cache;
}

/** The mirrored open editor buffers (with their unsaved content). */
export function getEditorMirrors(): EditorMirror[] {
  return cache.editors;
}

/** One mirrored editor buffer by its workspace-relative path / untitled key. */
export function getEditorMirror(path: string): EditorMirror | undefined {
  return cache.editors.find((e) => e.path === path);
}

/** The mirrored file-explorer tree state. */
export function getExplorerMirror(): ExplorerMirror {
  return cache.explorer;
}
