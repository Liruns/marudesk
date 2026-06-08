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
test('worktree lanes: lists every worktree of the active repo', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-lanes-'));
  const linked = `${repo}-wt`;
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(['init', '-b', 'main'], repo);
  git(
    [
      '-c', 'user.email=t@t',
      '-c', 'user.name=t',
      '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '-m', 'init',
    ],
    repo,
  );
  git(['worktree', 'add', '-b', 'marudesk/agent/1', linked], repo);

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
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(linked, { recursive: true, force: true });
  }
});
