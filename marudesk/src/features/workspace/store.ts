import { create } from 'zustand';
import type { Capture } from '../../../shared/capture';
import type { RankedFile, WorkspaceSummary } from '../../../shared/workspace';
import { toMessage } from '../../lib/toMessage';

/** A file/folder cut or copied, awaiting paste. */
export type Clipboard = { path: string; mode: 'cut' | 'copy' };

/** An in-progress inline edit in the tree: renaming an item, or naming a new
 *  one (where `path` is the parent directory, '' for the workspace root). */
export type PendingEdit = {
  kind: 'rename' | 'new-file' | 'new-folder';
  path: string;
};

type WorkspaceState = {
  summary: WorkspaceSummary | null;
  opening: boolean;
  /** Directory paths whose children are currently shown in the tree. */
  expandedDirs: Set<string>;
  /** Path of the file selected in the tree, if any. */
  selectedPath: string | null;
  clipboard: Clipboard | null;
  pendingEdit: PendingEdit | null;
  ranking: Record<string, RankedFile[]>;
  rankingPending: Record<string, boolean>;
  rankingError: Record<string, string>;
};

type WorkspaceActions = {
  openWorkspace: () => Promise<void>;
  reindex: () => Promise<void>;
  toggleDir: (path: string) => void;
  expandDir: (path: string) => void;
  selectFile: (path: string) => void;
  collapseAll: () => void;
  setClipboard: (path: string, mode: 'cut' | 'copy') => void;
  clearClipboard: () => void;
  beginRename: (path: string) => void;
  beginCreate: (parentDir: string, kind: 'file' | 'dir') => void;
  cancelPending: () => void;
  rankCapture: (capture: Capture) => Promise<void>;
  clearRanking: (captureId: string) => void;
};

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>(
  (set, get) => ({
    summary: null,
    opening: false,
    expandedDirs: new Set<string>(),
    selectedPath: null,
    clipboard: null,
    pendingEdit: null,
    ranking: {},
    rankingPending: {},
    rankingError: {},

    openWorkspace: async () => {
      if (get().opening) return;
      set({ opening: true });
      try {
        const summary = await window.marudesk.invoke(
          'workspace:open',
        );
        if (summary) {
          set({
            summary,
            expandedDirs: new Set<string>(),
            selectedPath: null,
            clipboard: null,
            pendingEdit: null,
            ranking: {},
            rankingPending: {},
            rankingError: {},
          });
        }
      } finally {
        set({ opening: false });
      }
    },

    reindex: async () => {
      const { summary, opening } = get();
      if (!summary || opening) return;
      set({ opening: true });
      try {
        const next = await window.marudesk.invoke(
          'workspace:list',
          summary.root,
        );
        if (next) {
          // Re-listing the same root: deliberately keep tree expansion and the
          // selected file. The tree is rebuilt from next.files, so a path that
          // vanished simply stops matching a row — a stale selection or
          // expanded dir self-corrects to nothing rather than needing a prune.
          set({
            summary: next,
            ranking: {},
            rankingPending: {},
            rankingError: {},
          });
        }
      } finally {
        set({ opening: false });
      }
    },

    toggleDir: (path) =>
      set((s) => {
        const expandedDirs = new Set(s.expandedDirs);
        if (expandedDirs.has(path)) expandedDirs.delete(path);
        else expandedDirs.add(path);
        return { expandedDirs };
      }),

    expandDir: (path) =>
      set((s) => {
        if (s.expandedDirs.has(path)) return {};
        const expandedDirs = new Set(s.expandedDirs);
        expandedDirs.add(path);
        return { expandedDirs };
      }),

    selectFile: (path) => set({ selectedPath: path }),

    collapseAll: () => set({ expandedDirs: new Set<string>() }),

    setClipboard: (path, mode) => set({ clipboard: { path, mode } }),

    clearClipboard: () => set({ clipboard: null }),

    beginRename: (path) => set({ pendingEdit: { kind: 'rename', path } }),

    beginCreate: (parentDir, kind) =>
      set((s) => {
        const expandedDirs = new Set(s.expandedDirs);
        if (parentDir) expandedDirs.add(parentDir);
        return {
          expandedDirs,
          pendingEdit: {
            kind: kind === 'dir' ? 'new-folder' : 'new-file',
            path: parentDir,
          },
        };
      }),

    cancelPending: () => set({ pendingEdit: null }),

    rankCapture: async (capture) => {
      const { summary, ranking, rankingPending } = get();
      if (!summary) return;
      if (ranking[capture.id] || rankingPending[capture.id]) return;
      set((s) => ({
        rankingPending: { ...s.rankingPending, [capture.id]: true },
      }));
      try {
        const ranked = await window.marudesk.invoke(
          'workspace:rank',
          {
            tagName: capture.tagName,
            selector: capture.selector,
            text: capture.text,
            attributes: capture.attributes,
          },
        );
        set((s) => {
          const nextPending = { ...s.rankingPending };
          delete nextPending[capture.id];
          const nextError = { ...s.rankingError };
          delete nextError[capture.id];
          return {
            ranking: { ...s.ranking, [capture.id]: ranked },
            rankingPending: nextPending,
            rankingError: nextError,
          };
        });
      } catch (err) {
        const msg = toMessage(err);
        set((s) => {
          const nextPending = { ...s.rankingPending };
          delete nextPending[capture.id];
          return {
            rankingPending: nextPending,
            rankingError: { ...s.rankingError, [capture.id]: msg },
          };
        });
      }
    },

    clearRanking: (captureId) =>
      set((s) => {
        const nextRanking = { ...s.ranking };
        const nextPending = { ...s.rankingPending };
        const nextError = { ...s.rankingError };
        delete nextRanking[captureId];
        delete nextPending[captureId];
        delete nextError[captureId];
        return {
          ranking: nextRanking,
          rankingPending: nextPending,
          rankingError: nextError,
        };
      }),
  }),
);
