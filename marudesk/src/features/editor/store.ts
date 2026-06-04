import { create } from 'zustand';
import type { TabState } from '../../../shared/browser';
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

type EditorState = {
  /** Keyed by workspace-relative POSIX path. */
  files: Record<string, FileBuf>;
};

type EditorActions = {
  openFile: (path: string) => Promise<void>;
  ensureLoaded: (path: string) => Promise<void>;
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

    openFile: async (path) => {
      const tabsState = useTabsStore.getState();
      const existing = tabsState.tabs.find(
        (t) => t.kind === 'editor' && t.filePath === path,
      );
      if (existing) {
        await tabsState.activateTab(existing.id);
      } else {
        // Main process creates + activates the editor tab and broadcasts the
        // new tabs snapshot; the path binding rides along in TabState.filePath.
        await window.marudesk.invoke('browser:tabs-new', {
          kind: 'editor',
          path,
        });
      }
      await get().ensureLoaded(path);
    },

    ensureLoaded: async (path) => {
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
      set((s) => ({ files: { ...s.files, [path]: { status: 'loading' } } }));
      try {
        const res = await window.marudesk.invoke(
          'workspace:read-file',
          path,
        );
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
        await window.marudesk.invoke('workspace:write-file', {
          path,
          content: toWrite,
        });
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
        for (const [p, buf] of Object.entries(s.files)) {
          if (openPaths.has(p)) next[p] = buf;
          else dropped.push(p);
        }
        return dropped.length ? { files: next } : {};
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
  if (!tab || tab.kind !== 'editor' || !tab.filePath) return true;
  const buf = useEditorStore.getState().files[tab.filePath];
  if (!isDirty(buf)) return true;
  return window.confirm(`Discard unsaved changes to ${tab.filePath}?`);
}

// Drop buffers (and dispose Monaco models) when an editor tab closes. Keyed by
// the doc key (real path or untitled-by-tab-id) so a save-as rebind — same tab
// id, new filePath — also re-prunes the stale untitled buffer.
subscribeTabsByKind(
  'editor',
  (t) => t.filePath ?? untitledDocKey(t.id),
  (liveKeys) => useEditorStore.getState().pruneClosed(liveKeys),
);
