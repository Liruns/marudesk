import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Worktree lanes board (docs/runtime-agent-absorption-2026-06.md §3.8). The
 * Source Control panel lists every git worktree of the active repo via
 * git:worktree-list. We verify the IPC end-to-end: a repo with a second worktree
 * reports both, the main one flagged, each carrying a change count.
 */
function initRepo(repo: string): (args: string[], cwd?: string) => void {
  const git = (args: string[], cwd: string = repo) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['commit', '--allow-empty', '-m', 'init']);
  return git;
}

test('worktree lanes: lists every worktree of the active repo', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-lanes-'));
  const linked = `${repo}-wt`;
  const git = initRepo(repo);
  git(['worktree', 'add', '-b', 'marudesk/agent/1', linked]);

  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      (root) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Repo',
          roots: [{ name: 'Root', path: root }],
        }),
      repo,
    );

    const lanes = await page.evaluate(() => window.marudesk.invoke('git:worktree-list'));
    expect(lanes.length).toBeGreaterThanOrEqual(2);
    expect(lanes.some((l) => l.isMain)).toBe(true);
    expect(lanes.some((l) => l.branch === 'marudesk/agent/1')).toBe(true);
    // Each lane carries a numeric change count (clean repo → 0).
    expect(lanes.every((l) => typeof l.changes === 'number')).toBe(true);

    // Cleanup (§3.8): removing the main worktree is refused...
    const main = lanes.find((l) => l.isMain)!;
    const refused = await page.evaluate(
      (p) => window.marudesk.invoke('git:worktree-remove', { path: p }),
      main.path,
    );
    expect(refused.ok).toBe(false);

    // ...but a stale agent lane discards, dropping the board back to the main tree.
    const agent = lanes.find((l) => l.branch === 'marudesk/agent/1')!;
    const removed = await page.evaluate(
      (p) => window.marudesk.invoke('git:worktree-remove', { path: p }),
      agent.path,
    );
    expect(removed.ok).toBe(true);
    const after = await page.evaluate(() => window.marudesk.invoke('git:worktree-list'));
    expect(after.some((l) => l.branch === 'marudesk/agent/1')).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(linked, { recursive: true, force: true });
  }
});

test('worktree lanes: merge-lane lands the work on the base branch + cleans up', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-lanes-m-'));
  const linked = `${repo}-wt`;
  const git = initRepo(repo);
  git(['worktree', 'add', '-b', 'marudesk/agent/2', linked]);
  // Make a change inside the lane (left uncommitted — mergeWorktree commits it).
  fs.writeFileSync(path.join(linked, 'from-lane.txt'), 'agent work\n');

  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      (root) => window.marudesk.invoke('workspaces:create', { name: 'R', roots: [{ name: 'R', path: root }] }),
      repo,
    );
    const lanes = await page.evaluate(() => window.marudesk.invoke('git:worktree-list'));
    const lane = lanes.find((l) => l.branch === 'marudesk/agent/2')!;

    const res = await page.evaluate(
      (p) => window.marudesk.invoke('git:worktree-merge-lane', { path: p }),
      lane.path,
    );
    expect(res.ok).toBe(true);
    // The lane's file landed on the main worktree, and the lane is gone.
    expect(fs.existsSync(path.join(repo, 'from-lane.txt'))).toBe(true);
    const after = await page.evaluate(() => window.marudesk.invoke('git:worktree-list'));
    expect(after.some((l) => l.branch === 'marudesk/agent/2')).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(linked, { recursive: true, force: true });
  }
});

test('worktree lanes: GitHub status reports why it is unavailable (no network)', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-lanes-gh-'));
  const git = initRepo(repo);

  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      (root) => window.marudesk.invoke('workspaces:create', { name: 'R', roots: [{ name: 'R', path: root }] }),
      repo,
    );

    // No origin remote at all.
    const noRemote = await page.evaluate(() =>
      window.marudesk.invoke('lanes-github:status', { force: true }),
    );
    expect(noRemote).toEqual({ ok: false, reason: 'no-remote' });

    // A non-GitHub origin is reported as such (still no network involved).
    git(['remote', 'add', 'origin', 'git@gitlab.com:x/y.git']);
    const notGithub = await page.evaluate(() =>
      window.marudesk.invoke('lanes-github:status', { force: true }),
    );
    expect(notGithub).toEqual({ ok: false, reason: 'not-github' });
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
