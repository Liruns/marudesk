/**
 * Types for the workspace Source Control feature (electron/git.ts ↔
 * src/features/git). All git invocations run in main against the open
 * workspace root via execFile (argv arrays, never a shell); these are the
 * sanitized shapes that cross IPC.
 */

/**
 * A single XY status code from `git status --porcelain`. Index (staged) status
 * is `index`; worktree (unstaged) status is `worktree`. Untracked files report
 * `'?'` in both. A space means "unmodified in this column".
 */
export type GitFileStatus =
  | ' '
  | 'M' // modified
  | 'A' // added
  | 'D' // deleted
  | 'R' // renamed
  | 'C' // copied
  | 'U' // unmerged / conflict
  | 'T' // type changed
  | '?'; // untracked

/** One changed path in the working tree, as parsed from porcelain status. */
export type GitChange = {
  /** Workspace-relative POSIX path. For a rename, the new path. */
  path: string;
  /** Original path for a rename/copy (workspace-relative POSIX), else null. */
  origPath: string | null;
  /** Index (staged) column. */
  indexStatus: GitFileStatus;
  /** Worktree (unstaged) column. */
  worktreeStatus: GitFileStatus;
  /** True when there is anything staged in the index column. */
  staged: boolean;
  /** True for an untracked file (`??`). */
  untracked: boolean;
  /** True for an unmerged (conflicted) path. */
  conflicted: boolean;
};

/**
 * Result of `git:status`. When the workspace isn't a git repo, `isRepo` is
 * false and the panel shows an "initialize repository?" affordance — this is
 * not an error.
 */
export type GitStatus =
  | { isRepo: false }
  | {
      isRepo: true;
      /** Current branch, or null when detached / on an unborn branch. */
      branch: string | null;
      /** Upstream ref short name (e.g. "origin/main"), or null. */
      upstream: string | null;
      /** Commits ahead of upstream (0 when no upstream). */
      ahead: number;
      /** Commits behind upstream (0 when no upstream). */
      behind: number;
      /** True before the first commit (unborn HEAD). */
      unborn: boolean;
      /** Changed files (staged + unstaged + untracked), one row per path. */
      files: GitChange[];
    };

/** One commit from `git:log`. */
export type GitCommit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** Human-friendly relative date, e.g. "3 hours ago". */
  relDate: string;
};

/** Local branches + the current one, from `git:branches`. */
export type GitBranches = {
  current: string | null;
  branches: string[];
};

/** Result of `git:commit`: the new HEAD short hash + its subject. */
export type GitCommitResult = { shortHash: string; subject: string };

/** Result of a remote op (`git:fetch`/`pull`/`push`): a short human summary. */
export type GitRemoteResult = { ok: true; summary: string };

/**
 * Result of `git:available`: whether a usable `git` binary is on PATH. The
 * Source Control panel checks this before anything else so a machine with no
 * git shows a clear "install git" prompt instead of a stuck spinner / raw
 * ENOENT from every command.
 */
export type GitAvailability = { installed: boolean; version?: string };
