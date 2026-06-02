import { create } from 'zustand';
import type {
  GitBranches,
  GitChange,
  GitCommit,
  GitStatus,
} from '../../../shared/git';
import { toMessage } from '../../lib/toMessage';
import { toast } from '../../lib/toast';

/**
 * Source Control state. Mirrors the main-owned git status into three buckets
 * the panel renders (Staged / Changes / Untracked), plus the recent-commit log
 * and branch list. There's no file-watching for the MVP — the panel refreshes
 * on open and after every mutating op (the actions call refresh() themselves).
 */

type GitState = {
  /** null until the first refresh resolves. */
  status: GitStatus | null;
  branches: GitBranches | null;
  log: GitCommit[];
  loading: boolean;
  /** A non-fatal error from the last op, surfaced inline + via toast. */
  error: string | null;
  /** True while a mutating op is in flight (disables the relevant buttons). */
  busy: boolean;
};

type GitActions = {
  refresh: () => Promise<void>;
  init: () => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  stageAll: () => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
  commit: (message: string, amend?: boolean) => Promise<boolean>;
  checkout: (name: string) => Promise<void>;
  createBranch: (name: string) => Promise<void>;
  fetch: () => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
};

export const useGitStore = create<GitState & GitActions>((set, get) => ({
  status: null,
  branches: null,
  log: [],
  loading: false,
  error: null,
  busy: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const status = await window.marudesk.invoke('git:status');
      if (!status.isRepo) {
        set({ status, branches: null, log: [], loading: false, error: null });
        return;
      }
      // Branches + log are independent of status; fetch them together.
      const [branches, log] = await Promise.all([
        window.marudesk.invoke('git:branches'),
        window.marudesk.invoke('git:log'),
      ]);
      set({ status, branches, log, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: toMessage(err) });
    }
  },

  init: async () => {
    await run(set, async () => {
      await window.marudesk.invoke('git:init');
    });
    await get().refresh();
  },

  stage: async (paths) => {
    if (paths.length === 0) return;
    await run(set, () => window.marudesk.invoke('git:stage', { paths }));
    await get().refresh();
  },

  stageAll: async () => {
    await run(set, () => window.marudesk.invoke('git:stageAll'));
    await get().refresh();
  },

  unstage: async (paths) => {
    if (paths.length === 0) return;
    await run(set, () => window.marudesk.invoke('git:unstage', { paths }));
    await get().refresh();
  },

  discard: async (paths) => {
    if (paths.length === 0) return;
    // Destructive — the caller (panel) confirms before invoking this.
    await run(set, () => window.marudesk.invoke('git:discard', { paths }));
    await get().refresh();
  },

  commit: async (message, amend = false) => {
    let ok = false;
    await run(set, async () => {
      const res = await window.marudesk.invoke('git:commit', { message, amend });
      ok = true;
      toast({
        title: `Committed ${res.shortHash}`,
        description: res.subject,
        variant: 'success',
      });
    });
    await get().refresh();
    return ok;
  },

  checkout: async (name) => {
    await run(set, () => window.marudesk.invoke('git:checkout', { name }));
    await get().refresh();
  },

  createBranch: async (name) => {
    await run(set, () =>
      window.marudesk.invoke('git:createBranch', { name, checkout: true }),
    );
    await get().refresh();
  },

  fetch: async () => {
    await run(set, async () => {
      const res = await window.marudesk.invoke('git:fetch');
      toast({ title: 'Fetch', description: res.summary, variant: 'neutral' });
    });
    await get().refresh();
  },

  pull: async () => {
    await run(set, async () => {
      const res = await window.marudesk.invoke('git:pull');
      toast({ title: 'Pull', description: res.summary, variant: 'success' });
    });
    await get().refresh();
  },

  push: async () => {
    await run(set, async () => {
      const res = await window.marudesk.invoke('git:push');
      toast({ title: 'Push', description: res.summary, variant: 'success' });
    });
    await get().refresh();
  },
}));

/**
 * Run a mutating op with the shared busy flag + error/toast handling, so every
 * action surfaces failures the same way (and never leaves `busy` stuck on).
 */
async function run(
  set: (partial: Partial<GitState>) => void,
  fn: () => Promise<unknown>,
): Promise<void> {
  set({ busy: true, error: null });
  try {
    await fn();
    set({ busy: false });
  } catch (err) {
    const msg = toMessage(err);
    set({ busy: false, error: msg });
    toast({ title: 'Git error', description: msg, variant: 'error' });
  }
}

/** Split the status file list into the three panel buckets. */
export function bucketChanges(files: GitChange[]): {
  staged: GitChange[];
  changes: GitChange[];
  untracked: GitChange[];
} {
  const staged: GitChange[] = [];
  const changes: GitChange[] = [];
  const untracked: GitChange[] = [];
  for (const f of files) {
    if (f.untracked) untracked.push(f);
    else {
      // A file can be both staged AND have further unstaged edits — it then
      // shows in both Staged (index half) and Changes (worktree half).
      if (f.staged) staged.push(f);
      if (f.worktreeStatus !== ' ' || f.conflicted) changes.push(f);
    }
  }
  return { staged, changes, untracked };
}
