import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Per-lane dev server (docs/runtime-agent-absorption-2026-06.md §3.8 Mission
 * Control). The lanes board runs `settings.lanes.devCommand` inside a worktree
 * lane, scrapes its localhost URL from the output, and can stop it. We drive the
 * full loop: set the command, start it in the repo's worktree, see status
 * running + the detected URL, then stop it and watch the lane clear.
 */
test('lanes dev server: start detects the URL, stop clears it', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-dev-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['commit', '--allow-empty', '-m', 'init']);

  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      (root) => window.marudesk.invoke('workspaces:create', { name: 'Dev', roots: [{ name: 'R', path: root }] }),
      repo,
    );
    // A dev command that prints a localhost URL then stays alive.
    await page.evaluate(() =>
      window.marudesk.invoke('settings:set', {
        lanes: { devCommand: 'echo "Local: http://localhost:4321/" && sleep 30' },
      }),
    );

    const start = await page.evaluate(
      (p) => window.marudesk.invoke('lanes-dev:start', { path: p }),
      repo,
    );
    expect(start.ok).toBe(true);

    // Status reaches running with the scraped URL.
    await expect
      .poll(
        async () => {
          const list = await page.evaluate(() => window.marudesk.invoke('lanes-dev:list'));
          const d = list.find((s) => s.path === repo);
          return d ? `${d.status}:${d.url ?? ''}` : null;
        },
        { timeout: 10_000, intervals: [200, 400, 800] },
      )
      .toBe('running:http://localhost:4321');

    // Stop clears the lane (onExit removes it).
    expect(await page.evaluate((p) => window.marudesk.invoke('lanes-dev:stop', { path: p }), repo)).toBe(true);
    await expect
      .poll(async () => {
        const list = await page.evaluate(() => window.marudesk.invoke('lanes-dev:list'));
        return list.some((s) => s.path === repo);
      })
      .toBe(false);
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
