import path from 'node:path';
import fs from 'node:fs/promises';
import { isSshRootKey } from '../shared/ssh';
import {
  AGENT_WORKTREE_BRANCH_PREFIX,
  isAgentWorktreeBranch,
  type WorktreeChanges,
  type WorktreeInfo,
  type WorktreeMergeResult,
} from '../shared/worktree';
import { runGit } from './git';

/**
 * Git worktree engine (v6 §G1 / Stage 12-A) — the isolation foundation the
 * parallel-thread model (Stage 12-B) builds on. Creates/lists/removes a second
 * working tree on a dedicated `marudesk/agent/*` branch, summarizes its pending
 * changes, and merges that branch back into the base branch (or discards it).
 *
 * Every command goes through {@link runGit} (electron/git.ts), so it inherits
 * the Source-Control hardening: argv-only (no shell), the SSH-root guard, the
 * stable C-locale / non-interactive-credential env, and the buffer cap. Pure of
 * Electron — paths/branches are passed in — so it's headlessly testable
 * (electron/git-worktree.harness.ts).
 */

/** A sample cap on the changed-file list returned to the UI. */
const MAX_CHANGE_SAMPLE = 50;

/** A unique agent branch name for a new worktree (timestamp-based, our prefix). */
export function agentBranchName(now = Date.now()): string {
  return `${AGENT_WORKTREE_BRANCH_PREFIX}${now}`;
}

/** Whether `root` is a LOCAL git work tree — the only kind that can host a worktree. */
export async function isGitRepo(root: string): Promise<boolean> {
  if (isSshRootKey(root)) return false;
  try {
    const { stdout } = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Parse `git worktree list --porcelain` into {@link WorktreeInfo}[]. Records are
 * blank-line separated; the FIRST record is always the repo's main working tree.
 */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> | null = null;
  const flush = (): void => {
    if (cur && typeof cur.path === 'string') {
      out.push({
        path: cur.path,
        head: cur.head ?? null,
        branch: cur.branch ?? null,
        isMain: out.length === 0,
        locked: cur.locked ?? false,
      });
    }
    cur = null;
  };
  for (const line of porcelain.split('\n')) {
    if (line.length === 0) {
      flush();
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') cur = { path: value };
    else if (cur && key === 'HEAD') cur.head = value || null;
    else if (cur && key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '') || null;
    else if (cur && key === 'detached') cur.branch = null;
    else if (cur && key === 'locked') cur.locked = true;
  }
  flush();
  return out;
}

/** List every worktree attached to the repo at `repoRoot` (main first). */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const { stdout } = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  return parseWorktreeList(stdout);
}

/**
 * Create an isolated worktree at `worktreePath` on a fresh `branch` off the
 * repo's current HEAD. The parent directory is created first; git refuses if the
 * path already exists or the branch is taken, surfacing a clear error.
 */
export async function createWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<WorktreeInfo> {
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  // `-b <branch>`: create the branch at HEAD and check it out in the new tree.
  await runGit(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  const list = await listWorktrees(repoRoot);
  const made = list.find((w) => path.resolve(w.path) === path.resolve(worktreePath));
  if (!made) throw new Error('worktree was added but is not listed');
  return made;
}

/**
 * Remove a worktree's working directory and prune its admin entry. `force`
 * removes it even with uncommitted changes (used by discard); without it git
 * refuses a dirty worktree, protecting unmerged work.
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  force = false,
): Promise<void> {
  await runGit(repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]);
}

/** Summarize the pending (uncommitted) changes in a worktree's working tree. */
export async function worktreeChanges(worktreePath: string): Promise<WorktreeChanges> {
  const { stdout } = await runGit(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const records = stdout.split('\0').filter((r) => r.length > 0);
  // Porcelain entries are "XY <path>"; a rename carries the old path as its own
  // trailing record, harmless to count as one more changed path in the sample.
  const files = records.map((r) => r.slice(3)).filter(Boolean);
  return { count: records.length, files: files.slice(0, MAX_CHANGE_SAMPLE) };
}

/**
 * Stage everything and commit the worktree's pending changes on its branch.
 * Returns `committed: false` (no error) when the tree is already clean, so a
 * merge can proceed idempotently.
 */
export async function commitWorktree(
  worktreePath: string,
  message: string,
): Promise<{ committed: boolean }> {
  const { count } = await worktreeChanges(worktreePath);
  if (count === 0) return { committed: false };
  await runGit(worktreePath, ['add', '-A']);
  await runGit(worktreePath, ['commit', '-m', message.trim() || 'agent worktree changes']);
  return { committed: true };
}

/** Resolve the short name of the branch currently checked out at `root`. */
async function currentBranch(root: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(root, ['symbolic-ref', '--short', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null; // detached HEAD
  }
}

/**
 * Merge an agent worktree's branch back into the base branch checked out in the
 * main working tree, then clean the worktree + branch up. Pending worktree edits
 * are committed first. A merge conflict (or a base that can't fast-forward
 * cleanly) is reported as `{ ok:false, reason:'conflict' }` with the worktree
 * LEFT INTACT — the merge is aborted so nothing is lost and the user can resolve
 * it by hand. NEVER uses --force.
 */
export async function mergeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  commitMessage: string,
): Promise<WorktreeMergeResult> {
  if (!isAgentWorktreeBranch(branch)) {
    return { ok: false, reason: 'error', message: `refusing to merge a non-agent branch: ${branch}` };
  }
  const base = await currentBranch(repoRoot);
  if (!base) {
    return { ok: false, reason: 'error', message: 'the main working tree is in a detached HEAD; check out a branch first' };
  }
  if (base === branch) {
    return { ok: false, reason: 'error', message: 'the main working tree has the agent branch checked out' };
  }
  try {
    await commitWorktree(worktreePath, commitMessage);
  } catch (err) {
    return { ok: false, reason: 'error', message: `could not commit worktree changes: ${(err as Error).message}` };
  }
  try {
    // --no-ff keeps the agent run as a visible merge commit on the base branch.
    const { stdout, stderr } = await runGit(repoRoot, ['merge', '--no-ff', '-m', `Merge ${branch}`, branch]);
    const summary = (stdout || stderr).trim().split('\n')[0] || `merged ${branch}`;
    // Clean up only on a successful merge: drop the worktree, then its branch.
    await removeWorktree(repoRoot, worktreePath, true).catch(() => undefined);
    await runGit(repoRoot, ['branch', '-D', branch]).catch(() => undefined);
    return { ok: true, merged: true, summary };
  } catch (err) {
    const detail = ((err as { stderr?: string; message?: string }).stderr || (err as Error).message || '').trim();
    // Abort a half-applied merge so the base tree is restored; keep the worktree.
    await runGit(repoRoot, ['merge', '--abort']).catch(() => undefined);
    const conflict = /conflict|would be overwritten|not something we can merge|local changes/i.test(detail);
    return {
      ok: false,
      reason: conflict ? 'conflict' : 'error',
      message: detail || 'merge failed',
    };
  }
}

/**
 * Discard an agent worktree entirely: force-remove its working tree and delete
 * its branch. Used when the user rejects the isolated run. Best-effort branch
 * delete (a half-created worktree may have no branch yet).
 */
export async function discardWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string | null,
): Promise<void> {
  await removeWorktree(repoRoot, worktreePath, true);
  if (branch && isAgentWorktreeBranch(branch)) {
    await runGit(repoRoot, ['branch', '-D', branch]).catch(() => undefined);
  }
}
