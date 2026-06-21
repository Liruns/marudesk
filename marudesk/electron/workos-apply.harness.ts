import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
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

    /* ── 0. a workspaceId that differs from the active workspace is REJECTED ─
       DATA-INTEGRITY guard: a task bound to a different workspace must never
       have its diff written into the active repo. The harness fixture sets
       `currentWorkspace` but no active record, so getActiveWorkspaceId() is the
       SYSTEM fallback ('system'); any other workspaceId is therefore a mismatch.
       The apply must bail BEFORE touching the file. */
    const mismatch = await applyTaskPatch({ taskId: 't1', patch: diff, workspaceId: 'other-workspace' });
    check('mismatched workspaceId → ok:false (apply rejected)', mismatch.ok === false);
    check('mismatched workspaceId left the live file untouched', readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'one\ntwo\nthree\n');

    /* A workspaceId that MATCHES the active workspace ('system' fallback here)
       applies exactly as before — the guard only rejects a true mismatch. Revert
       afterwards so the omitted-workspaceId case below starts from a clean tree. */
    const matched = await applyTaskPatch({ taskId: 't1', patch: diff, workspaceId: 'system' });
    check('matching workspaceId applies (ok:true)', matched.ok === true);
    check('matching workspaceId landed the edit', readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'one\nTWO\nthree\n');
    await git(repo, ['checkout', '--', 'app.txt']);

    /* A PRESENT-but-malformed workspaceId (number/null/object) is a caller error,
       not an unbound task — it must be REJECTED as invalid input, never coerced to
       undefined (which would bypass the cross-workspace guard above). The file must
       stay clean for every malformed shape. */
    const cleanFile = 'one\ntwo\nthree\n';
    const malformed = [123, null, {}, []] as const;
    for (const bad of malformed) {
      const rejected = await applyTaskPatch({ taskId: 't1', patch: diff, workspaceId: bad });
      check(`malformed workspaceId (${JSON.stringify(bad)}) → ok:false (invalid input)`, rejected.ok === false);
      check(`malformed workspaceId (${JSON.stringify(bad)}) left the live file untouched`, readFileSync(path.join(repo, 'app.txt'), 'utf8') === cleanFile);
    }

    /* ── 1. a clean diff applies to the live workspace (workspaceId omitted) ─ */
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

    /* ── 3b. MALICIOUS patches escaping the repo are REFUSED ──────────────────
       The agent-produced diff is prompt-injectable, so applyTaskPatch leans on
       git's built-in rejection of out-of-tree write targets (no --unsafe-paths).
       Pin that defense: a parent-traversal, an absolute path, and (POSIX) a
       symlink-escape patch must each be rejected AND leave the filesystem
       OUTSIDE the repo untouched. Targets live under the harness temp dir at
       fixed names so the assertions are deterministic. */
    const escapeDir = mkdtempSync(path.join(tmpdir(), 'workos-apply-escape-'));
    try {
      /* parent-directory traversal: the patch creates ../<escapeRel>. We add a
         deep subdir inside the repo so `../../…` resolves into escapeDir, and
         point the apply at it via a path that climbs out of the repo root. */
      const traversalRel = '../workos-apply-escape-traversal.txt';
      const traversalTarget = path.join(path.dirname(repo), 'workos-apply-escape-traversal.txt');
      const traversalDiff =
        `diff --git a/${traversalRel} b/${traversalRel}\n` +
        'new file mode 100644\n' +
        'index 0000000..9daeafb\n' +
        '--- /dev/null\n' +
        `+++ b/${traversalRel}\n` +
        '@@ -0,0 +1 @@\n' +
        '+pwned\n';
      const traversal = await applyTaskPatch({ taskId: 't1', patch: traversalDiff });
      check('malicious traversal patch (../) → ok:false (git refuses out-of-tree path)', traversal.ok === false);
      check('traversal patch created NO file outside the repo', !existsSync(traversalTarget));

      /* absolute target path: an absolute b/ path must be refused; git apply
         rejects absolute paths regardless of OS. Use an absolute path rooted in
         escapeDir so a (hypothetical) leak is observable on this platform. */
      const absTarget = path.join(escapeDir, 'absolute-evil.txt');
      // Git diff paths are forward-slash; an absolute POSIX-style path is absolute
      // to git on every OS. On Windows the drive-letter form is also absolute.
      const absRel = absTarget.split(path.sep).join('/');
      const absDiff =
        `diff --git a/${absRel} b/${absRel}\n` +
        'new file mode 100644\n' +
        'index 0000000..9daeafb\n' +
        '--- /dev/null\n' +
        `+++ b/${absRel}\n` +
        '@@ -0,0 +1 @@\n' +
        '+pwned\n';
      const absolute = await applyTaskPatch({ taskId: 't1', patch: absDiff });
      check('malicious absolute-path patch → ok:false (git refuses absolute target)', absolute.ok === false);
      check('absolute-path patch created NO file at the absolute target', !existsSync(absTarget));

      /* symlink escape (POSIX only): a symlink inside the repo points at escapeDir;
         a patch writing THROUGH it must be refused (git rejects paths that pass
         beyond a symlink). Windows symlink creation needs privileges, so guard. */
      if (process.platform !== 'win32') {
        const linkName = 'link';
        symlinkSync(escapeDir, path.join(repo, linkName), 'dir');
        const symlinkTarget = path.join(escapeDir, 'through-symlink.txt');
        const symlinkRel = `${linkName}/through-symlink.txt`;
        const symlinkDiff =
          `diff --git a/${symlinkRel} b/${symlinkRel}\n` +
          'new file mode 100644\n' +
          'index 0000000..9daeafb\n' +
          '--- /dev/null\n' +
          `+++ b/${symlinkRel}\n` +
          '@@ -0,0 +1 @@\n' +
          '+pwned\n';
        const symlink = await applyTaskPatch({ taskId: 't1', patch: symlinkDiff });
        check('malicious symlink-escape patch → ok:false (git refuses path through a symlink)', symlink.ok === false);
        check('symlink-escape patch created NO file beyond the symlink', !existsSync(symlinkTarget));
      }
    } finally {
      rmSync(escapeDir, { recursive: true, force: true });
    }

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
