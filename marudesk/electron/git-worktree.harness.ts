import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  agentBranchName,
  createWorktree,
  discardWorktree,
  isGitRepo,
  listWorktrees,
  mergeWorktree,
  parseWorktreeList,
  worktreeChanges,
} from './git-worktree.ts';
import { isAgentWorktreeBranch } from '../shared/worktree.ts';

/**
 * Harness for the Stage 12-A git worktree engine. Spins up a REAL throwaway git
 * repo in a temp dir and drives the full lifecycle (create → edit → changes →
 * commit/merge → cleanup, plus discard), so the git plumbing is verified end to
 * end without Electron. Run via `npm run harness:worktree`.
 */

const exec = promisify(execFile);
let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', root, ...args], { env: { ...process.env, LC_ALL: 'C' } });
  return stdout;
}

async function main(): Promise<void> {
  /* ── pure parser unit ─────────────────────────────────────────────────── */
  {
    const sample =
      'worktree /repo/main\nHEAD abc123\nbranch refs/heads/main\n\n' +
      'worktree /repo/wt\nHEAD def456\nbranch refs/heads/marudesk/agent/1\n\n';
    const list = parseWorktreeList(sample);
    check('parse: two worktrees parsed', list.length === 2);
    check('parse: first is flagged main', list[0]!.isMain === true && list[0]!.branch === 'main');
    check('parse: branch ref prefix stripped', list[1]!.branch === 'marudesk/agent/1');
    check('parse: second is not main', list[1]!.isMain === false);
    check('branch helper: agent branch recognized', isAgentWorktreeBranch(list[1]!.branch!) === true);
  }

  const base = mkdtempSync(path.join(tmpdir(), 'wt-repo-'));
  const wtPath = path.join(mkdtempSync(path.join(tmpdir(), 'wt-tree-')), 'agent');
  try {
    /* ── set up a real repo with one commit on `main` ─────────────────────── */
    await git(base, ['init', '-b', 'main']);
    await git(base, ['config', 'user.email', 'harness@example.com']);
    await git(base, ['config', 'user.name', 'Harness']);
    // The repo (and its worktrees, which share this config) must not inherit a
    // global commit-signing hook — the throwaway repo has no signing identity.
    await git(base, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(path.join(base, 'app.txt'), 'line one\nline two\n');
    await git(base, ['add', '-A']);
    await git(base, ['commit', '-m', 'initial']);

    check('isGitRepo: a real repo is detected', (await isGitRepo(base)) === true);
    check('isGitRepo: a non-repo temp dir is not', (await isGitRepo(tmpdir())) === false);
    check('isGitRepo: an ssh:// root is rejected', (await isGitRepo('ssh://host/repo')) === false);

    /* ── create an isolated worktree off HEAD ─────────────────────────────── */
    const branch = agentBranchName(1700000000000);
    const info = await createWorktree(base, wtPath, branch);
    check('create: worktree dir exists on disk', existsSync(wtPath));
    check('create: returned info is on the agent branch', info.branch === branch && info.isMain === false);
    check('create: worktree inherited the base file', readFileSync(path.join(wtPath, 'app.txt'), 'utf8') === 'line one\nline two\n');

    const listed = await listWorktrees(base);
    check('list: main + the new worktree are both listed', listed.length === 2 && listed.some((w) => w.branch === branch));

    /* ── changes + commit in the worktree ─────────────────────────────────── */
    check('changes: a fresh worktree is clean', (await worktreeChanges(wtPath)).count === 0);
    writeFileSync(path.join(wtPath, 'app.txt'), 'line one\nEDITED\n');
    writeFileSync(path.join(wtPath, 'new.txt'), 'brand new\n');
    const changes = await worktreeChanges(wtPath);
    check('changes: edits + untracked counted', changes.count === 2 && changes.files.includes('new.txt'));

    /* ── merge the worktree branch back into main, then it is cleaned up ──── */
    const merged = await mergeWorktree(base, wtPath, branch, 'agent edits');
    check('merge: reports ok', merged.ok === true);
    check('merge: main now has the edited content', readFileSync(path.join(base, 'app.txt'), 'utf8') === 'line one\nEDITED\n');
    check('merge: the new file landed on main', existsSync(path.join(base, 'new.txt')));
    check('merge: worktree dir was removed', !existsSync(wtPath));
    const afterMerge = await listWorktrees(base);
    check('merge: only the main worktree remains', afterMerge.length === 1 && afterMerge[0]!.isMain);
    const branches = await git(base, ['branch', '--list', '--format=%(refname:short)']);
    check('merge: the agent branch was deleted', !branches.split('\n').map((s) => s.trim()).includes(branch));

    /* ── discard path: create another, edit, then throw it away ───────────── */
    const wt2 = path.join(mkdtempSync(path.join(tmpdir(), 'wt-tree2-')), 'agent');
    const branch2 = agentBranchName(1700000000001);
    await createWorktree(base, wt2, branch2);
    writeFileSync(path.join(wt2, 'scratch.txt'), 'discard me\n');
    await discardWorktree(base, wt2, branch2);
    check('discard: worktree dir removed even when dirty', !existsSync(wt2));
    const afterDiscard = await git(base, ['branch', '--list', '--format=%(refname:short)']);
    check('discard: the agent branch was deleted', !afterDiscard.split('\n').map((s) => s.trim()).includes(branch2));
    check('discard: main file is untouched', readFileSync(path.join(base, 'app.txt'), 'utf8') === 'line one\nEDITED\n');
    rmSync(path.dirname(wt2), { recursive: true, force: true });

    /* ── safety: merge refuses a non-agent branch ─────────────────────────── */
    const refused = await mergeWorktree(base, wtPath, 'main', 'x');
    check('safety: merge refuses a non-agent branch', refused.ok === false && refused.reason === 'error');

    /* ── rename: worktreeChanges parses the R record's NEW path (not "xt") ─── */
    const wt3 = path.join(mkdtempSync(path.join(tmpdir(), 'wt-tree3-')), 'agent');
    const branch3 = agentBranchName(1700000000002);
    await createWorktree(base, wt3, branch3);
    await git(wt3, ['mv', 'app.txt', 'renamed.txt']);
    const renChanges = await worktreeChanges(wt3);
    check('rename: the NEW path is reported (porcelain R record parsed)', renChanges.files.includes('renamed.txt'));
    check('rename: the mangled "xt" old-path slice is NOT present', !renChanges.files.includes('xt'));
    check('rename: counted as a single change', renChanges.count === 1);

    /* ── conflict: a real content conflict is classified as `conflict` ─────── */
    // Base and the worktree both change the same line → git merge conflicts.
    await git(wt3, ['reset', '--hard']); // drop the uncommitted rename from above
    writeFileSync(path.join(base, 'app.txt'), 'line one\nBASE-EDIT\n');
    await git(base, ['commit', '-am', 'base edits the same line']);
    writeFileSync(path.join(wt3, 'app.txt'), 'line one\nWORKTREE-EDIT\n');
    const conflict = await mergeWorktree(base, wt3, branch3, 'agent edit conflicting line');
    check('conflict: a content conflict is classified conflict (not generic error)', conflict.ok === false && conflict.reason === 'conflict');
    check('conflict: the worktree is preserved for resolution', existsSync(wt3));
    check('conflict: base was restored (merge aborted, no conflict markers committed)', readFileSync(path.join(base, 'app.txt'), 'utf8') === 'line one\nBASE-EDIT\n');
    rmSync(path.dirname(wt3), { recursive: true, force: true });

    console.log(`\ngit-worktree harness: ${passed} assertions passed`);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(path.dirname(wtPath), { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('git-worktree harness FAILED:', err);
  process.exitCode = 1;
});
