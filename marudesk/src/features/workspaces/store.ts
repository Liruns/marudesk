import { create } from 'zustand';
import {
  SYSTEM_WORKSPACE_ID,
  type WorkspaceId,
  type WorkspacePaneId,
  type WorkspaceRecord,
  type WorkspaceRootId,
  type WorkspaceRootInput,
  type WorkspaceSnapshot,
} from '../../../shared/workspace';
import { currentLocale } from '../../i18n/locale-storage';
import { getMessage } from '../../i18n/messages';
import { toMessage } from '../../lib/toMessage';
import { toast } from '../../lib/toast';
import {
  findSiblingLeaf,
  removeWorkspaceLeaf,
  sanitizeWorkspaceLayout,
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
  readonly createSshWorkspace: (
    params: { connectionId: string; remotePath: string; name?: string; workspaceName?: string },
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

/**
 * Resolve the workspace a surface should render. An instrument bound to a SPECIFIC
 * workspace passes its `preferredId`; surfaces that follow the global active
 * workspace pass `preferredId = undefined`. The preferred id wins when it resolves
 * to a known record; otherwise we fall back to the active workspace, so an unset
 * or stale binding degrades to today's active-workspace behavior rather than null.
 */
export function resolveWorkspaceFor(
  workspaces: readonly WorkspaceRecord[],
  preferredId: WorkspaceId | undefined,
  activeId: WorkspaceId | null,
): WorkspaceRecord | null {
  if (preferredId) {
    const preferred = workspaces.find((workspace) => workspace.id === preferredId);
    if (preferred) return preferred;
  }
  return workspaces.find((workspace) => workspace.id === activeId) ?? null;
}

function layoutForSnapshot(snapshot: WorkspaceSnapshot): WorkspaceLayoutNode | null {
  const focused =
    snapshot.focusedWorkspaceId ?? snapshot.activeWorkspaceId ?? snapshot.workspaces[0]?.id;
  if (!focused) return null;
  return workspaceLeaf(focused);
}

/**
 * After creating a workspace, ingest the new snapshot AND point a visible pane at
 * the new workspace — the stage/tab strip/file tree render from the layout leaf's
 * workspaceId, not from activeWorkspaceId, so without repointing the workspace
 * would be "active" yet no pane would show it.
 */
function applyCreatedWorkspace(
  state: WorkspaceDeckState,
  snapshot: WorkspaceSnapshot,
  recordId: WorkspaceId,
): WorkspaceDeckState {
  const next = applySnapshot(state, snapshot);
  let layout = next.layout ?? workspaceLeaf(recordId);
  const targetPane = next.focusedPaneId ?? workspaceLeaves(layout)[0]?.id ?? null;
  if (targetPane) layout = setWorkspaceLeaf(layout, targetPane, recordId);
  return {
    ...next,
    activeWorkspaceId: recordId,
    focusedPaneId: targetPane ?? next.focusedPaneId,
    layout,
  };
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

/**
 * Surface a workspace MUTATION failure (create / rename / delete / add-folder /
 * remove-root / reindex). These are fire-and-forget `void`-called from the title-
 * bar WorkspaceSwitcher, whose menu has closed by the time a reject lands, so the
 * stored `error` (which no chrome renders) was the only signal — i.e. the action
 * silently no-op'd. Toast it, mirroring setActiveWorkspace/setActiveRoot. (Not
 * used for `refresh`, a background load.)
 */
function reportWorkspaceFailure(message: string): void {
  toast({
    title: getMessage(currentLocale(), 'workspaces.actionFailed.title'),
    description: message,
    variant: 'error',
  });
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
        set((state) => applyCreatedWorkspace(state, snapshot, record.id));
        return record;
      } catch (err) {
        const message = toMessage(err);
        set({ loading: false, error: message });
        reportWorkspaceFailure(message);
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
      try {
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
      } catch (err) {
        // Callers fire-and-forget (`void setActiveWorkspace(…)`), so surface the
        // failure both in store state AND a toast — the switcher menu has usually
        // closed by the time the reject lands. Return normally; never rethrow.
        const message = toMessage(err);
        set({ error: message });
        toast({
          title: getMessage(currentLocale(), 'workspaces.switchFailed.title'),
          description: message,
          variant: 'error',
        });
      }
    },

    addRoot: async (workspaceId) => {
      set({ loading: true, error: null });
      try {
        const record = await window.marudesk.invoke('workspaces:add-root', { workspaceId });
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => applySnapshot(state, snapshot));
        return record;
      } catch (err) {
        const message = toMessage(err);
        set({ loading: false, error: message });
        reportWorkspaceFailure(message);
        return null;
      }
    },

    createSshWorkspace: async (params) => {
      set({ loading: true, error: null });
      try {
        const record = await window.marudesk.invoke('workspaces:create-ssh', params);
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => applyCreatedWorkspace(state, snapshot, record.id));
        return record;
      } catch (err) {
        const message = toMessage(err);
        set({ loading: false, error: message });
        reportWorkspaceFailure(message);
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
        const message = toMessage(err);
        set({ loading: false, error: message });
        reportWorkspaceFailure(message);
        return null;
      }
    },

    setActiveRoot: async (workspaceId, rootId) => {
      try {
        const snapshot = await window.marudesk.invoke('workspaces:set-active-root', {
          workspaceId,
          rootId,
        });
        set((state) => applySnapshot(state, snapshot));
      } catch (err) {
        const message = toMessage(err);
        set({ error: message });
        toast({
          title: getMessage(currentLocale(), 'workspaces.switchFailed.title'),
          description: message,
          variant: 'error',
        });
      }
    },

    renameWorkspace: async (workspaceId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        await window.marudesk.invoke('workspaces:rename', { workspaceId, name: trimmed });
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => applySnapshot(state, snapshot));
      } catch (err) {
        const message = toMessage(err);
        set({ error: message });
        reportWorkspaceFailure(message);
      }
    },

    removeRoot: async (workspaceId, rootId) => {
      try {
        await window.marudesk.invoke('workspaces:remove-root', { workspaceId, rootId });
        const snapshot = await window.marudesk.invoke('workspaces:list');
        set((state) => applySnapshot(state, snapshot));
      } catch (err) {
        const message = toMessage(err);
        set({ error: message });
        reportWorkspaceFailure(message);
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
        const message = toMessage(err);
        set({ error: message });
        reportWorkspaceFailure(message);
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
        const message = toMessage(err);
        set({ error: message });
        reportWorkspaceFailure(message);
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
      const sibling = findSiblingLeaf(layout, paneId);
      const next = removeWorkspaceLeaf(layout, paneId);
      const leaves = workspaceLeaves(next);
      const focused = sibling ?? leaves[0] ?? null;
      set({
        layout: next,
        focusedPaneId: focused?.id ?? null,
        activeWorkspaceId: focused?.workspaceId ?? null,
      });
    },
  }),
);

/* ── deck-layout persistence (split arrangement → main JSON) ─────────────── */

let layoutPersistenceStarted = false;
let pendingSavedLayout: unknown = null;
// True once we've had a chance to apply (or decided there's nothing to apply).
// Guards the push so a default single-pane layout can't overwrite the saved file
// before the restore lands.
let restoreSettled = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let lastPushedJson = '';

/** Apply the saved layout once workspaces exist; reconcile against them. */
function tryApplySavedLayout(): void {
  if (restoreSettled || pendingSavedLayout == null) return;
  const st = useWorkspaceDeckStore.getState();
  if (st.workspaces.length === 0) return; // wait until workspaces are restored
  const valid = new Set(st.workspaces.map((w) => w.id));
  valid.add(SYSTEM_WORKSPACE_ID);
  const layout = sanitizeWorkspaceLayout(pendingSavedLayout, (id) => valid.has(id));
  pendingSavedLayout = null;
  restoreSettled = true;
  if (!layout) return;
  const leaves = workspaceLeaves(layout);
  const focusedPaneId =
    leaves.find((l) => l.workspaceId === st.activeWorkspaceId)?.id ?? leaves[0]?.id ?? null;
  useWorkspaceDeckStore.setState({ layout, focusedPaneId });
}

/**
 * Start persisting the workspace deck layout to main: load the saved tree, apply
 * it once workspaces are present (reconciled), and push later changes (debounced).
 * Idempotent; safe to call from every WorkspaceStage mount.
 */
export async function startLayoutPersistence(): Promise<void> {
  if (layoutPersistenceStarted) return;
  layoutPersistenceStarted = true;
  try {
    pendingSavedLayout = await window.marudesk.invoke('ui:get-layout');
  } catch {
    pendingSavedLayout = null;
  }
  // Nothing to restore → allow saving immediately.
  if (pendingSavedLayout == null) restoreSettled = true;
  tryApplySavedLayout();
  useWorkspaceDeckStore.subscribe((state) => {
    tryApplySavedLayout();
    if (!restoreSettled) return; // don't overwrite the saved file before restore
    const layout = state.layout;
    if (!layout) return;
    const json = JSON.stringify(layout);
    if (json === lastPushedJson) return;
    lastPushedJson = json;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      void window.marudesk.invoke('ui:set-layout', layout);
    }, 500);
  });
}
