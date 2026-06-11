import { useEffect } from 'react';
import type { ContextSyncPayload, EditorMirror, ExplorerMirror } from '../../../shared/context';
import { useTabsStore } from '../tabs/store';
import { editorDocKeyForTab, untitledDocKey, useEditorStore } from '../editor/store';
import { useWorkspaceStore } from '../workspace/store';

/**
 * Mirror the renderer-only surfaces to main for the built-in context MCP
 * (docs/context-mcp-design §3): the open editor buffers (incl. unsaved edits) and
 * the file-explorer's tree state. main can't observe these, so the agent's
 * `read_editor` / `read_explorer` tools rely on this push. One-way and debounced
 * — pushed on store changes, never round-tripped.
 */

const MAX_EDITOR_CONTENT = 20_000;
const DEBOUNCE_MS = 400;

function buildPayload(): ContextSyncPayload {
  const { tabs } = useTabsStore.getState();
  const { files } = useEditorStore.getState();
  const ws = useWorkspaceStore.getState();

  const editors: EditorMirror[] = tabs
    .filter((t) => t.kind === 'editor')
    .map((t) => {
      const key = editorDocKeyForTab(t) ?? untitledDocKey(t.id);
      const buf = files[key];
      const content =
        buf?.status === 'ready' && buf.kind === 'text' ? buf.content : '';
      const dirty =
        !!buf &&
        buf.status === 'ready' &&
        buf.kind === 'text' &&
        buf.content !== buf.saved;
      const truncated = content.length > MAX_EDITOR_CONTENT;
      return {
        path: key,
        dirty,
        content: truncated ? content.slice(0, MAX_EDITOR_CONTENT) : content,
        truncated,
      };
    });

  const explorer: ExplorerMirror = {
    root: ws.summary?.root ?? null,
    expandedDirs: [...ws.expandedDirs],
    selectedPath: ws.selectedPath,
    fileCount: ws.summary?.files.length,
  };

  return { editors, explorer };
}

/**
 * Subscribe the three source stores and push a debounced context snapshot to
 * main. Mount once at the app root.
 */
export function useContextSync(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSent = '';
    const push = (): void => {
      timer = undefined;
      try {
        const payload = buildPayload();
        // The source stores churn on every tab focus / selection change; only
        // pay the IPC + main-side cache write + LSP document resync when the
        // mirrored content actually changed.
        const signature = JSON.stringify(payload);
        if (signature === lastSent) return;
        lastSent = signature;
        void window.marudesk.invoke('context:sync', payload);
      } catch {
        // best-effort — a failed mirror just leaves the prior cache in place
      }
    };
    const schedule = (): void => {
      if (timer !== undefined) return;
      timer = setTimeout(push, DEBOUNCE_MS);
    };

    schedule(); // initial snapshot once stores have hydrated
    const unsubs = [
      useTabsStore.subscribe(schedule),
      useEditorStore.subscribe(schedule),
      useWorkspaceStore.subscribe(schedule),
    ];
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const u of unsubs) u();
    };
  }, []);
}
