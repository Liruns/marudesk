import { create } from 'zustand';
import type { TabState } from '../../../shared/browser';
import {
  workspaceFileKey,
  type WorkspaceFileRef,
} from '../../../shared/workspace';
import { toMessage } from '../../lib/toMessage';
import { subscribeTabsByKind, useTabsStore } from '../tabs/store';
import {
  isTextFileBuf,
  readResultToFileBuf,
  type FileBuf,
} from './buffer';

export function untitledDocKey(tabId: string): string {
  return `untitled-${tabId}`;
}
function isUntitledKey(key: string): boolean {
  return key.startsWith('untitled-');
}
export type { ErrorFileBuf, FileBuf } from './buffer';

type EditorFileInput = string | WorkspaceFileRef;

function isWorkspaceFileRef(value: EditorFileInput): value is WorkspaceFileRef {
  return typeof value !== 'string';
}

export function editorDocKeyForTab(tab: TabState): string | null {
  if (tab.kind !== 'editor') return null;
  if (tab.editorFile) return workspaceFileKey(tab.editorFile);
  return tab.filePath ?? untitledDocKey(tab.id);
}

function docKeyForInput(input: EditorFileInput): string {
  return isWorkspaceFileRef(input) ? workspaceFileKey(input) : input;
}

/**
 * A request to reveal a 1-based line/column in a document, set when a feature
 * (the Search panel) opens a file at a specific match. MonacoView watches this
 * and reveals once for each new `nonce`, so re-binding the model on a later tab
 * switch doesn't re-jump to a stale position.
 */
export type RevealRequest = {
  key: string;
  line: number;
  col: number;
  nonce: number;
};

type EditorState = {
  files: Record<string, FileBuf>;
  fileRefs: Record<string, WorkspaceFileRef>;
  revealRequest: RevealRequest | null;
};

type EditorActions = {
  openFile: (file: EditorFileInput) => Promise<void>;
  openFileAt: (file: EditorFileInput, line: number, col: number) => Promise<void>;
  ensureLoaded: (file: EditorFileInput) => Promise<void>;
  setContent: (path: string, content: string) => void;
  save: (path: string) => Promise<void>;
  saveUntitled: (key: string) => Promise<void>;
  pruneClosed: (openPaths: Set<string>) => void;
};

// monaco-setup registers its model disposer here once Monaco loads, so the
// store can dispose models without statically importing (and eagerly bundling)
// Monaco.
let modelDisposer: ((path: string) => void) | null = null;
export function registerModelDisposer(fn: (path: string) => void): void {
  modelDisposer = fn;
}

export const useEditorStore = create<EditorState & EditorActions>(
  (set, get) => ({
    files: {},
    fileRefs: {},
    revealRequest: null,

    openFile: async (file) => {
      const key = docKeyForInput(file);
      const tabsState = useTabsStore.getState();
      const existing = tabsState.tabs.find(
        (t) => t.kind === 'editor' && editorDocKeyForTab(t) === key,
      );
      if (existing) {
        await tabsState.activateTab(existing.id);
      } else {
        if (isWorkspaceFileRef(file)) {
          await window.marudesk.invoke('browser:tabs-new', {
            kind: 'editor',
            file,
            workspaceId: file.workspaceId,
          });
        } else {
          await window.marudesk.invoke('browser:tabs-new', {
            kind: 'editor',
            path: file,
          });
        }
      }
      await get().ensureLoaded(file);
    },

    openFileAt: async (file, line, col) => {
      await get().openFile(file);
      // EditorView only mounts MonacoView once the buffer is ready, so the
      // request is in place before the editor binds the model and can apply it.
      set((s) => ({
        revealRequest: {
          key: docKeyForInput(file),
          line,
          col,
          nonce: (s.revealRequest?.nonce ?? 0) + 1,
        },
      }));
    },

    ensureLoaded: async (file) => {
      const path = docKeyForInput(file);
      const cur = get().files[path];
      if (cur && (cur.status === 'loading' || cur.status === 'ready')) return;
      if (isUntitledKey(path)) {
        // Untitled scratch buffer — no disk read. Starts empty and unsaved
        // (no `saved`, so it reads dirty and Ctrl+S triggers Save As).
        set((s) => ({
          files: { ...s.files, [path]: { status: 'ready', kind: 'text', content: '' } },
        }));
        return;
      }
      if (isWorkspaceFileRef(file)) {
        set((s) => ({
          fileRefs: { ...s.fileRefs, [path]: file },
        }));
      }
      set((s) => ({ files: { ...s.files, [path]: { status: 'loading' } } }));
      try {
        const res = isWorkspaceFileRef(file)
          ? await window.marudesk.invoke('workspaces:read-file', file)
          : await window.marudesk.invoke('workspace:read-file', path);
        set((s) => ({
          files: {
            ...s.files,
            [path]: res.ok
              ? readResultToFileBuf(res)
              : { status: 'error', reason: res.reason, size: res.size },
          },
        }));
      } catch (err) {
        const msg = toMessage(err);
        set((s) => ({
          files: { ...s.files, [path]: { status: 'error', error: msg } },
        }));
      }
    },

    setContent: (path, content) =>
      set((s) => {
        const f = s.files[path];
        if (!isTextFileBuf(f)) return {};
        if (f.content === content) return {};
        return { files: { ...s.files, [path]: { ...f, content } } };
      }),

    save: async (path) => {
      const f = get().files[path];
      if (!isTextFileBuf(f)) return;
      if (isUntitledKey(path)) {
        await get().saveUntitled(path);
        return;
      }
      if (f.saving || f.content === f.saved) return;
      const toWrite = f.content;
      set((s) => {
        const cur = s.files[path];
        if (!isTextFileBuf(cur)) return {};
        return { files: { ...s.files, [path]: { ...cur, saving: true } } };
      });
      try {
        const file = get().fileRefs[path];
        if (file) {
          await window.marudesk.invoke('workspaces:write-file', {
            file,
            content: toWrite,
          });
        } else {
          await window.marudesk.invoke('workspace:write-file', {
            path,
            content: toWrite,
          });
        }
        set((s) => {
          const cur = s.files[path];
          if (!isTextFileBuf(cur)) return {};
          // `saved` becomes exactly what we persisted; if the user kept typing
          // during the await, content has advanced and the file stays dirty.
          return {
            files: { ...s.files, [path]: { ...cur, saved: toWrite, saving: false } },
          };
        });
      } catch (err) {
        const msg = toMessage(err);
        set((s) => {
          const cur = s.files[path];
          if (!isTextFileBuf(cur)) return {};
          return {
            files: { ...s.files, [path]: { ...cur, saving: false, error: msg } },
          };
        });
      }
    },

    saveUntitled: async (key) => {
      const f = get().files[key];
      if (!isTextFileBuf(f) || f.saving) return;
      const tabId = key.slice('untitled-'.length);
      const content = f.content;
      set((s) => {
        const cur = s.files[key];
        if (!isTextFileBuf(cur)) return {};
        return { files: { ...s.files, [key]: { ...cur, saving: true } } };
      });
      try {
        const res = await window.marudesk.invoke(
          'workspace:save-as',
          { content },
        );
        if (!res.ok) {
          // Canceled dialog or write error — clear saving, keep the buffer.
          set((s) => {
            const cur = s.files[key];
            if (!isTextFileBuf(cur)) return {};
            return {
              files: {
                ...s.files,
                [key]: { ...cur, saving: false, error: res.reason },
              },
            };
          });
          return;
        }
        // Seed the real-path buffer so the rebind shows content immediately,
        // then bind the tab to the path. The snapshot push swaps the tab's
        // docKey to the path; the prune subscription drops this untitled buffer
        // and disposes its Monaco model.
        const path = res.path;
        // Re-read the live buffer — the user may have typed during the modal
        // Save As dialog. Persisted bytes are `content`; the buffer mirror is
        // the live text, so the tab stays dirty if it advanced rather than
        // showing "Saved" while holding unpersisted edits.
        const liveBuf = get().files[key];
        const live = isTextFileBuf(liveBuf) ? liveBuf.content : content;
        set((s) => ({
          files: {
            ...s.files,
            [path]: { status: 'ready', kind: 'text', content: live, saved: content },
          },
        }));
        await window.marudesk.invoke('browser:tabs-bind-path', {
          id: tabId,
          path,
        });
      } catch (err) {
        const msg = toMessage(err);
        set((s) => {
          const cur = s.files[key];
          if (!isTextFileBuf(cur)) return {};
          return {
            files: {
              ...s.files,
              [key]: { ...cur, saving: false, error: msg },
            },
          };
        });
      }
    },

    pruneClosed: (openPaths) => {
      const dropped: string[] = [];
      set((s) => {
        const next: Record<string, FileBuf> = {};
        const nextRefs: Record<string, WorkspaceFileRef> = {};
        for (const [p, buf] of Object.entries(s.files)) {
          if (openPaths.has(p)) {
            next[p] = buf;
            const ref = s.fileRefs[p];
            if (ref) nextRefs[p] = ref;
          } else {
            dropped.push(p);
          }
        }
        return dropped.length ? { files: next, fileRefs: nextRefs } : {};
      });
      // Dispose Monaco models for closed files synchronously, so a model's
      // lifetime tracks its buffer: a reopened file always rebuilds from fresh
      // disk content rather than racing a deferred dispose against a stale
      // cached model. modelDisposer is null until Monaco loads — but until then
      // no models exist to dispose, so the no-op is correct and keeps Monaco
      // out of the startup bundle.
      if (modelDisposer) {
        for (const p of dropped) modelDisposer(p);
      }
    },
  }),
);

/** Returns true when a file has unsaved edits. */
export function isDirty(buf: FileBuf | undefined): boolean {
  return isTextFileBuf(buf) && buf.content !== buf.saved;
}

/**
 * Gate for closing a tab: true if it's safe to close now. For a dirty editor
 * tab it prompts to discard, so neither the X button nor Ctrl/Cmd+W can drop
 * unsaved edits silently.
 */
export function confirmCloseTab(tab: TabState | undefined): boolean {
  if (!tab || tab.kind !== 'editor') return true;
  const key = editorDocKeyForTab(tab);
  if (!key || isUntitledKey(key)) return true;
  const buf = useEditorStore.getState().files[key];
  if (!isDirty(buf)) return true;
  const label = tab.editorFile
    ? `${tab.editorFile.rootId} / ${tab.editorFile.path}`
    : tab.filePath ?? key;
  return window.confirm(`Discard unsaved changes to ${label}?`);
}

// Drop buffers (and dispose Monaco models) when an editor tab closes. Keyed by
// the doc key (real path or untitled-by-tab-id) so a save-as rebind — same tab
// id, new filePath — also re-prunes the stale untitled buffer.
subscribeTabsByKind(
  'editor',
  (t) => editorDocKeyForTab(t) ?? untitledDocKey(t.id),
  (liveKeys) => useEditorStore.getState().pruneClosed(liveKeys),
);
