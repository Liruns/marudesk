/**
 * Git worktree isolation types (v6 §G1 / Stage 12-A). An agent can run in a
 * dedicated git worktree — a second working tree on its own branch off the
 * repo's HEAD — so risky edits stay isolated and can be reviewed, then merged
 * back into the base branch or discarded as a unit. These are pure types shared
 * by the main-process engine (electron/git-worktree.ts) and the renderer.
 *
 * Only LOCAL git repositories qualify: an SSH/remote root has no local checkout
 * to add a worktree to, and a non-git folder has no branches.
 */

/** Branch-name prefix for every agent worktree, so they're easy to spot + sweep. */
export const AGENT_WORKTREE_BRANCH_PREFIX = 'marudesk/agent/';

/** Whether a branch name is one of ours (an agent worktree branch). */
export function isAgentWorktreeBranch(branch: string): boolean {
  return branch.startsWith(AGENT_WORKTREE_BRANCH_PREFIX);
}

/** One worktree as `git worktree list --porcelain` reports it. */
export type WorktreeInfo = {
  /** Absolute path of the worktree's working directory. */
  path: string;
  /** Checked-out commit sha, or null for a freshly-added one with no HEAD yet. */
  head: string | null;
  /** Short branch name (e.g. `marudesk/agent/1700000000000`), or null when detached. */
  branch: string | null;
  /** True for the repo's primary working tree (the original checkout). */
  isMain: boolean;
  /** True while another process holds this worktree locked. */
  locked: boolean;
};

/** Pending (uncommitted) change summary in a worktree. */
export type WorktreeChanges = {
  /** Number of changed paths (tracked edits + untracked files). */
  count: number;
  /** Up to a bounded sample of the changed workspace-relative paths. */
  files: string[];
};

/** One worktree plus its pending-change count, for the Source Control lanes board. */
export type WorktreeLane = WorktreeInfo & {
  /** Number of uncommitted changes in this worktree (0 when clean). */
  changes: number;
};

/**
 * Outcome of merging an agent worktree's branch back into the base branch. A
 * clean merge reports `ok` with the short summary; a conflict (or a dirty base)
 * reports `conflict` with git's message so the UI can surface it — the worktree
 * is left intact in that case so nothing is lost.
 */
export type WorktreeMergeResult =
  | { ok: true; merged: boolean; summary: string }
  | { ok: false; reason: 'conflict' | 'error'; message: string };

/**
 * Worktree-isolation status for one workspace root, surfaced to the renderer
 * (Stage 12-B). `eligible` is whether the root is a local git repo that COULD be
 * isolated; when `active`, it also carries the agent branch + pending changes.
 */
export type WorktreeIsolationStatus =
  | { active: false; eligible: boolean }
  | {
      active: true;
      eligible: true;
      branch: string;
      worktreePath: string;
      changes: WorktreeChanges;
    };
