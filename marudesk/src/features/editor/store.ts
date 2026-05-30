import { create } from 'zustand';
import type { TabState } from '../../../shared/browser';
import { toMessage } from '../../lib/toMessage';
import { subscribeTabsByKind, useTabsStore } from '../tabs/store';

/** Synthetic store key for an unsaved (untitled) editor tab, keyed by tab id. */
export function untitledDocKey(tabId: string): string {
  return `untitled-${tabId}`;
}
function isUntitledKey(key: string): boolean {
  return key.startsWith('untitled-');
}

/** Per-file editor buffer. `content` mirrors the live Monaco model so dirty
 *  state and the save payload live in the store (observable by the tab strip). */
export type FileBuf = {
  status: 'loading' | 'ready' | 'error';
  content?: string;
  saved?: string;
  saving?: boolean;
  /** Why an uneditable file can't be opened. */
  reason?: 'too-large' | 'binary' | 'not-a-file';
  size?: number;
  error?: string;
};

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
          files: { ...s.files, [path]: { status: 'ready', content: '' } },
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
              ? { status: 'ready', content: res.content, saved: res.content }
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
        if (!f || f.status !== 'ready') return {};
        if (f.content === content) return {};
        return { files: { ...s.files, [path]: { ...f, content } } };
      }),

    save: async (path) => {
      const f = get().files[path];
      if (!f || f.status !== 'ready' || f.content === undefined) return;
      if (isUntitledKey(path)) {
        await get().saveUntitled(path);
        return;
      }
      if (f.saving || f.content === f.saved) return;
      const toWrite = f.content;
      set((s) => ({
        files: { ...s.files, [path]: { ...s.files[path], saving: true } },
      }));
      try {
        await window.marudesk.invoke('workspace:write-file', {
          path,
          content: toWrite,
        });
        set((s) => {
          const cur = s.files[path];
          if (!cur) return {};
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
          if (!cur) return {};
          return {
            files: { ...s.files, [path]: { ...cur, saving: false, error: msg } },
          };
        });
      }
    },

    saveUntitled: async (key) => {
      const f = get().files[key];
      if (!f || f.status !== 'ready' || f.saving) return;
      const tabId = key.slice('untitled-'.length);
      const content = f.content ?? '';
      set((s) => ({
        files: { ...s.files, [key]: { ...s.files[key], saving: true } },
      }));
      try {
        const res = await window.marudesk.invoke(
          'workspace:save-as',
          { content },
        );
        if (!res.ok) {
          // Canceled dialog or write error — clear saving, keep the buffer.
          set((s) => ({
            files: {
              ...s.files,
              [key]: { ...s.files[key], saving: false, error: res.reason },
            },
          }));
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
        const live = get().files[key]?.content ?? content;
        set((s) => ({
          files: {
            ...s.files,
            [path]: { status: 'ready', content: live, saved: content },
          },
        }));
        await window.marudesk.invoke('browser:tabs-bind-path', {
          id: tabId,
          path,
        });
      } catch (err) {
        const msg = toMessage(err);
        set((s) => ({
          files: {
            ...s.files,
            [key]: { ...s.files[key], saving: false, error: msg },
          },
        }));
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
  return !!buf && buf.status === 'ready' && buf.content !== buf.saved;
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
