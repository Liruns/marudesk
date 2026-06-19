import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkspaceSummary } from '../shared/workspace.ts';
import { applyTaskPatch } from './agent/run-task.ts';
import { __setCurrentWorkspaceForTests } from './workspace-registry.ts';
import { check, passedCount } from './harness-kit';

/**
 * Harness for the Work OS apply-patch flow (`workos:apply-patch` →
 * {@link applyTaskPatch}): applying a task's reviewed worktree diff to the LIVE
 * workspace against a REAL temp git repo. Headless — `npm run harness:workos-apply`.
 *
 * Covers the safety-critical path: a clean diff lands, the apply is REJECTED (not
 * forced) once the live tree has drifted, malformed/empty patches are refused, and
 * the acceptance verdict stays honestly `null` when no checker applies.
 */

const exec = promisify(execFile);
async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', root, ...args], { env: { ...process.env, LC_ALL: 'C' } });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'workos-apply-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'h@e.com']);
  await git(dir, ['config', 'user.name', 'H']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  // Diffs below assert exact LF bytes — pin autocrlf off so a global setting
  // can't CRLF-ify the apply and break the content checks.
  await git(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(path.join(dir, 'app.txt'), 'one\ntwo\nthree\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

/** Capture a real unified diff (two → TWO), then revert so the tree is clean again. */
async function captureDiff(repo: string): Promise<string> {
  writeFileSync(path.join(repo, 'app.txt'), 'one\nTWO\nthree\n');
  const diff = await git(repo, ['diff']);
  await git(repo, ['checkout', '--', 'app.txt']);
  return diff;
}

async function main(): Promise<void> {
  const repo = await makeRepo();
  const ws: WorkspaceSummary = { root: repo, name: 'Test', files: [], source: 'git', truncated: false };
  __setCurrentWorkspaceForTests(ws);
  try {
    const diff = await captureDiff(repo);
    check('fixture: captured a non-empty diff', diff.includes('TWO'));
    check('fixture: working tree reverted to clean before apply', readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'one\ntwo\nthree\n');

    /* ── 1. a clean diff applies to the live workspace ────────────────────── */
    const res = await applyTaskPatch({ taskId: 't1', patch: diff });
    check('apply: ok', res.ok === true);
    check('apply: changedFiles names app.txt', res.ok === true && res.changedFiles.includes('app.txt'));
    check('apply: the edit landed in the live file', readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'one\nTWO\nthree\n');
    check('apply: verdict is null when no checker applies (honest, not faked green)', res.ok === true && res.verdict === null);

    /* ── 2. re-applying the same diff is REJECTED (live tree drifted) ─────── */
    const again = await applyTaskPatch({ taskId: 't1', patch: diff });
    check('re-apply rejected once the tree drifted (not forced)', again.ok === false);
    check('re-apply left the file unchanged', readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'one\nTWO\nthree\n');

    /* ── 3. malformed / empty input is refused ────────────────────────────── */
    check('empty patch rejected', (await applyTaskPatch({ taskId: 't1', patch: '   ' })).ok === false);
    check('missing patch field rejected', (await applyTaskPatch({ taskId: 't1' })).ok === false);
    check('non-object payload rejected', (await applyTaskPatch('nope')).ok === false);

    /* ── 4. no workspace → honest precondition failure ────────────────────── */
    __setCurrentWorkspaceForTests(null);
    const noWs = await applyTaskPatch({ taskId: 't1', patch: diff });
    check('no workspace open → ok:false', noWs.ok === false);

    console.log(`\nworkos-apply harness: ${passedCount()} assertions passed`);
  } finally {
    __setCurrentWorkspaceForTests(null);
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('workos-apply harness FAILED:', err);
  process.exitCode = 1;
});
