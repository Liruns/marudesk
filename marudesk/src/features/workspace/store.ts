import { create } from 'zustand';
import type { ElementCapture } from '../../../shared/capture';
import type {
  RankedFile,
  WorkspaceRecord,
  WorkspaceRootSummary,
  WorkspaceSummary,
} from '../../../shared/workspace';
import { toMessage } from '../../lib/toMessage';
import { useWorkspaceDeckStore } from '../workspaces/store';

/** A file/folder cut or copied, awaiting paste. */
export type Clipboard = { path: string; mode: 'cut' | 'copy' };

/** An in-progress inline edit in the tree: renaming an item, or naming a new
 *  one (where `path` is the parent directory, '' for the workspace root). */
export type PendingEdit = {
  kind: 'rename' | 'new-file' | 'new-folder';
  path: string;
};

/** A previously-opened workspace, surfaced on the home page for quick resume. */
export type RecentWorkspace = { root: string; name: string };

const RECENTS_KEY = 'marudesk.workspace.recents';
const RECENTS_MAX = 6;

function loadRecents(): RecentWorkspace[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentWorkspace =>
          !!r && typeof r.root === 'string' && typeof r.name === 'string',
      )
      .slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

/** Move/insert a workspace at the front (most-recent-first), dedup by root, persist. */
function pushRecent(list: RecentWorkspace[], entry: RecentWorkspace): RecentWorkspace[] {
  const next = [entry, ...list.filter((r) => r.root !== entry.root)].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
  return next;
}

function activeRoot(record: WorkspaceRecord): WorkspaceRootSummary | null {
  const preferred = record.activeRootId
    ? record.roots.find((root) => root.id === record.activeRootId)
    : undefined;
  return preferred ?? record.roots[0] ?? null;
}

export function summaryFromWorkspaceRecord(record: WorkspaceRecord): WorkspaceSummary | null {
  const root = activeRoot(record);
  if (!root) return null;
  return {
    root: root.root,
    name: record.roots.length > 1 ? `${record.name} / ${root.name}` : record.name,
    files: root.files,
    source: root.source,
    truncated: root.truncated,
  };
}

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
  /** Recently-opened workspaces (most-recent-first), for the home page. */
  recents: RecentWorkspace[];
};

type WorkspaceActions = {
  openWorkspace: () => Promise<void>;
  /** Re-open a workspace by its root path (from the home page's Recent list). */
  openRecent: (root: string) => Promise<void>;
  syncFromWorkspaceRecord: (record: WorkspaceRecord | null) => void;
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
  rankCapture: (capture: ElementCapture) => Promise<void>;
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
    recents: loadRecents(),

    openWorkspace: async () => {
      if (get().opening) return;
      set({ opening: true });
      try {
        const summary = await window.marudesk.invoke(
          'workspace:open',
        );
        if (summary) {
          await useWorkspaceDeckStore.getState().refresh();
          const recents = pushRecent(get().recents, { root: summary.root, name: summary.name });
          set({
            summary,
            recents,
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

    openRecent: async (root) => {
      if (get().opening) return;
      set({ opening: true });
      try {
        const summary = await window.marudesk.invoke('workspace:list', root);
        if (summary) {
          await useWorkspaceDeckStore.getState().refresh();
          const recents = pushRecent(get().recents, { root: summary.root, name: summary.name });
          set({
            summary,
            recents,
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

    syncFromWorkspaceRecord: (record) => {
      const summary = record ? summaryFromWorkspaceRecord(record) : null;
      set((s) => {
        if (!summary) return { summary: null };
        const sameRoot = s.summary?.root === summary.root;
        return {
          summary,
          expandedDirs: sameRoot ? s.expandedDirs : new Set<string>(),
          selectedPath: sameRoot ? s.selectedPath : null,
          clipboard: sameRoot ? s.clipboard : null,
          pendingEdit: sameRoot ? s.pendingEdit : null,
          ranking: {},
          rankingPending: {},
          rankingError: {},
        };
      });
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

// Mission Control has no WorkspaceStage to drive the Explorer summary, so mirror
// the deck's active workspace into it here — once on load and on every deck
// change. The summary is the source of truth for the Files instrument's tree and
// the agent's read_explorer context, so without this the tree stays empty under a
// real workspace and never refreshes when the active workspace switches. (This
// replaces the effect WorkspaceStage.tsx owned before it was deleted.)
function syncSummaryFromActiveWorkspace(): void {
  const deck = useWorkspaceDeckStore.getState();
  const record = deck.workspaces.find((w) => w.id === deck.activeWorkspaceId) ?? null;
  useWorkspaceStore.getState().syncFromWorkspaceRecord(record);
}
useWorkspaceDeckStore.subscribe(syncSummaryFromActiveWorkspace);
syncSummaryFromActiveWorkspace();
