import { create } from 'zustand';
import type {
  WorkspaceId,
  WorkspacePaneId,
  WorkspaceRecord,
  WorkspaceRootId,
  WorkspaceRootInput,
  WorkspaceSnapshot,
} from '../../../shared/workspace';
import { toMessage } from '../../lib/toMessage';
import {
  removeWorkspaceLeaf,
  setWorkspaceLeaf,
  setWorkspaceSplitRatio,
  splitWorkspaceLeaf,
  workspaceLeaf,
  workspaceLeaves,
  type WorkspaceLayoutNode,
  type WorkspaceSplitDir,
} from './layout';

type WorkspaceDeckState = {
  readonly revision: number;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly activeWorkspaceId: WorkspaceId | null;
  readonly focusedPaneId: WorkspacePaneId | null;
  readonly layout: WorkspaceLayoutNode | null;
  readonly loading: boolean;
  readonly error: string | null;
};

type WorkspaceDeckActions = {
  readonly refresh: () => Promise<void>;
  readonly ingestSnapshot: (snapshot: WorkspaceSnapshot) => void;
  readonly createWorkspace: (
    name: string,
    roots: readonly WorkspaceRootInput[],
  ) => Promise<WorkspaceRecord | null>;
  readonly renameWorkspace: (workspaceId: WorkspaceId, name: string) => Promise<void>;
  readonly deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
  readonly removeRoot: (
    workspaceId: WorkspaceId,
    rootId: WorkspaceRootId,
  ) => Promise<void>;
  readonly reindexWorkspace: (
    workspaceId: WorkspaceId,
    rootId?: WorkspaceRootId,
  ) => Promise<void>;
  readonly focusPane: (paneId: WorkspacePaneId) => void;
  readonly setActiveWorkspace: (
    workspaceId: WorkspaceId,
    paneId?: WorkspacePaneId,
  ) => Promise<void>;
  readonly addRoot: (workspaceId: WorkspaceId) => Promise<WorkspaceRecord | null>;
  readonly addSshRoot: (
    workspaceId: WorkspaceId,
    params: { connectionId: string; remotePath: string; name?: string },
  ) => Promise<WorkspaceRecord | null>;
  readonly setActiveRoot: (
    workspaceId: WorkspaceId,
    rootId: WorkspaceRootId,
  ) => Promise<void>;
  readonly splitFocusedPane: (
    workspaceId: WorkspaceId,
    dir: WorkspaceSplitDir,
    side?: 'before' | 'after',
  ) => void;
  readonly setPaneWorkspace: (
    paneId: WorkspacePaneId,
    workspaceId: WorkspaceId,
  ) => void;
  readonly resizeSplit: (splitId: WorkspacePaneId, ratio: number) => void;
  readonly closePane: (paneId: WorkspacePaneId) => void;
};

function layoutForSnapshot(snapshot: WorkspaceSnapshot): WorkspaceLayoutNode | null {
  const focused =
    snapshot.focusedWorkspaceId ?? snapshot.activeWorkspaceId ?? snapshot.workspaces[0]?.id;
  if (!focused) return null;
  return workspaceLeaf(focused);
}

function applySnapshot(
  state: WorkspaceDeckState,
  snapshot: WorkspaceSnapshot,
): WorkspaceDeckState {
  if (snapshot.revision < state.revision) {
    return { ...state, loading: false, error: null };
  }
  const activeWorkspaceId =
    snapshot.activeWorkspaceId ?? snapshot.focusedWorkspaceId ?? snapshot.workspaces[0]?.id ?? null;
  const nextLayout = state.layout ?? layoutForSnapshot(snapshot);
  const leaves = nextLayout ? workspaceLeaves(nextLayout) : [];
  const focusedPaneId =
    snapshot.focusedPaneId ??
    state.focusedPaneId ??
    leaves.find((leaf) => leaf.workspaceId === activeWorkspaceId)?.id ??
    leaves[0]?.id ??
    null;

  return {
    ...state,
    revision: snapshot.revision,
    workspaces: snapshot.workspaces,
    activeWorkspaceId,
    focusedPaneId,
    layout: nextLayout,
    loading: false,
    error: null,
  };
}

export const useWorkspaceDeckStore = create<WorkspaceDeckState & WorkspaceDeckActions>(
  (set, get) => ({
    revision: 0,
    workspaces: [],
    activeWorkspaceId: null,
    focusedPaneId: null,
    layout: null,
    loading: false,
    error: null,

    refresh: async () => {
      set({ loading: true, error: null });
      try {
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => applySnapshot(state, snapshot));
      } catch (err) {
        set({ loading: false, error: toMessage(err) });
      }
    },

    ingestSnapshot: (snapshot) => {
      set((state) => applySnapshot(state, snapshot));
    },

    createWorkspace: async (name, roots) => {
      set({ loading: true, error: null });
      try {
        const record = await window.marudesk.invoke('workspaces:create', {
          name,
          roots: [...roots],
        });
        if (!record) {
          set({ loading: false });
          return null;
        }
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => {
          const next = applySnapshot(state, snapshot);
          const layout = next.layout ?? workspaceLeaf(record.id);
          return {
            ...next,
            activeWorkspaceId: record.id,
            focusedPaneId: workspaceLeaves(layout)[0]?.id ?? next.focusedPaneId,
            layout,
          };
        });
        return record;
      } catch (err) {
        set({ loading: false, error: toMessage(err) });
        return null;
      }
    },

    focusPane: (paneId) => {
      const layout = get().layout;
      const leaf = layout
        ? workspaceLeaves(layout).find((entry) => entry.id === paneId)
        : null;
      set({
        focusedPaneId: paneId,
        activeWorkspaceId: leaf?.workspaceId ?? get().activeWorkspaceId,
      });
    },

    setActiveWorkspace: async (workspaceId, paneId) => {
      const payload = paneId ? { workspaceId, paneId } : { workspaceId };
      const snapshot = await window.marudesk.invoke('workspaces:set-active', payload);
      set((state) => {
        const next = applySnapshot(state, snapshot);
        return {
          ...next,
          layout:
            paneId && next.layout
              ? setWorkspaceLeaf(next.layout, paneId, workspaceId)
              : next.layout,
        };
      });
    },

    addRoot: async (workspaceId) => {
      set({ loading: true, error: null });
      try {
        const record = await window.marudesk.invoke('workspaces:add-root', { workspaceId });
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => applySnapshot(state, snapshot));
        return record;
      } catch (err) {
        set({ loading: false, error: toMessage(err) });
        return null;
      }
    },

    addSshRoot: async (workspaceId, params) => {
      set({ loading: true, error: null });
      try {
        const record = await window.marudesk.invoke('workspaces:add-ssh-root', {
          workspaceId,
          ...params,
        });
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => applySnapshot(state, snapshot));
        return record;
      } catch (err) {
        set({ loading: false, error: toMessage(err) });
        return null;
      }
    },

    setActiveRoot: async (workspaceId, rootId) => {
      const snapshot = await window.marudesk.invoke('workspaces:set-active-root', {
        workspaceId,
        rootId,
      });
      set((state) => applySnapshot(state, snapshot));
    },

    renameWorkspace: async (workspaceId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        await window.marudesk.invoke('workspaces:rename', { workspaceId, name: trimmed });
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => applySnapshot(state, snapshot));
      } catch (err) {
        set({ error: toMessage(err) });
      }
    },

    removeRoot: async (workspaceId, rootId) => {
      try {
        await window.marudesk.invoke('workspaces:remove-root', { workspaceId, rootId });
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => applySnapshot(state, snapshot));
      } catch (err) {
        set({ error: toMessage(err) });
      }
    },

    reindexWorkspace: async (workspaceId, rootId) => {
      try {
        await window.marudesk.invoke(
          'workspaces:reindex',
          rootId ? { workspaceId, rootId } : { workspaceId },
        );
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => applySnapshot(state, snapshot));
      } catch (err) {
        set({ error: toMessage(err) });
      }
    },

    deleteWorkspace: async (workspaceId) => {
      try {
        const snapshot = await window.marudesk.invoke('workspaces:delete', { workspaceId });
        set((state) => {
          const next = applySnapshot(state, snapshot);
          if (!next.layout) return next;
          // Panes still pointing at the deleted workspace are re-homed onto the
          // new active workspace so they don't fall back to the System pane.
          const fallback = next.activeWorkspaceId ?? next.workspaces[0]?.id ?? null;
          let layout = next.layout;
          if (fallback) {
            for (const leaf of workspaceLeaves(layout)) {
              if (leaf.workspaceId === workspaceId) {
                layout = setWorkspaceLeaf(layout, leaf.id, fallback);
              }
            }
          }
          const leaves = workspaceLeaves(layout);
          const focusedValid = leaves.some((leaf) => leaf.id === next.focusedPaneId);
          return {
            ...next,
            layout,
            focusedPaneId: focusedValid ? next.focusedPaneId : (leaves[0]?.id ?? null),
          };
        });
      } catch (err) {
        set({ error: toMessage(err) });
      }
    },

    splitFocusedPane: (workspaceId, dir, side = 'after') => {
      const { focusedPaneId, layout } = get();
      if (!focusedPaneId || !layout) return;
      const next = splitWorkspaceLeaf(layout, focusedPaneId, workspaceId, dir, side);
      const fresh = workspaceLeaves(next).find(
        (leaf) => leaf.workspaceId === workspaceId && leaf.id !== focusedPaneId,
      );
      set({
        layout: next,
        focusedPaneId: fresh?.id ?? focusedPaneId,
        activeWorkspaceId: workspaceId,
      });
    },

    setPaneWorkspace: (paneId, workspaceId) => {
      const layout = get().layout;
      if (!layout) return;
      set({
        layout: setWorkspaceLeaf(layout, paneId, workspaceId),
        focusedPaneId: paneId,
        activeWorkspaceId: workspaceId,
      });
    },

    resizeSplit: (splitId, ratio) => {
      const layout = get().layout;
      if (!layout) return;
      set({ layout: setWorkspaceSplitRatio(layout, splitId, ratio) });
    },

    closePane: (paneId) => {
      const layout = get().layout;
      if (!layout) return;
      const next = removeWorkspaceLeaf(layout, paneId);
      const leaves = workspaceLeaves(next);
      const focused = leaves[0] ?? null;
      set({
        layout: next,
        focusedPaneId: focused?.id ?? null,
        activeWorkspaceId: focused?.workspaceId ?? null,
      });
    },
  }),
);
