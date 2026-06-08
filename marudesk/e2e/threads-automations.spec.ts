import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers/app';

/**
 * Integration coverage for the Stage 12 IPC surfaces — exercised through the real
 * Electron main process (no model needed): the thread registry (12-B-2), the
 * automations store (12-C), and worktree isolation status (12-B). These are the
 * new agent/git channels added this round; the agent loop itself is covered by
 * agent.spec.ts.
 */

test('threads: list / new / switch / close round-trips through main', async () => {
  const { app, page } = await launchApp();
  try {
    // A fresh app always has exactly one active "main" thread.
    const initial = await page.evaluate(() => window.marudesk.invoke('agent:list-threads'));
    expect(initial.length).toBe(1);
    expect(initial[0]?.active).toBe(true);
    const mainId = initial[0]!.id;

    // Creating a thread switches to it (the new one becomes active + empty).
    const afterNew = await page.evaluate(() => window.marudesk.invoke('agent:new-thread'));
    expect(afterNew.length).toBe(2);
    const active = afterNew.find((t) => t.active)!;
    expect(active.id).not.toBe(mainId);
    expect(active.messageCount).toBe(0);

    // Switch back to main.
    const afterSwitch = await page.evaluate((id) => window.marudesk.invoke('agent:switch-thread', { id }), mainId);
    expect(afterSwitch.find((t) => t.active)?.id).toBe(mainId);

    // Close the non-main thread → back to one.
    const otherId = active.id;
    const afterClose = await page.evaluate((id) => window.marudesk.invoke('agent:close-thread', { id }), otherId);
    expect(afterClose.length).toBe(1);
    expect(afterClose[0]?.id).toBe(mainId);

    // The last thread cannot be closed.
    const afterCloseLast = await page.evaluate((id) => window.marudesk.invoke('agent:close-thread', { id }), mainId);
    expect(afterCloseLast.length).toBe(1);
  } finally {
    await app.close();
  }
});

test('automations: create / list / toggle / delete round-trips + persists', async () => {
  const { app, page } = await launchApp();
  try {
    const empty = await page.evaluate(() => window.marudesk.invoke('automations:list'));
    expect(Array.isArray(empty)).toBe(true);

    const created = await page.evaluate(() =>
      window.marudesk.invoke('automations:create', {
        name: 'Nightly scan',
        prompt: 'List new TODOs',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        schedule: { kind: 'interval', everyMinutes: 120 },
        allowTools: [],
        enabled: true,
      }),
    );
    expect(created.name).toBe('Nightly scan');
    expect(created.enabled).toBe(true);
    // An enabled interval automation gets a future nextRunAt.
    expect(typeof created.nextRunAt).toBe('number');

    const list = await page.evaluate(() => window.marudesk.invoke('automations:list'));
    expect(list.some((a) => a.id === created.id)).toBe(true);

    const disabled = await page.evaluate(
      (id) => window.marudesk.invoke('automations:set-enabled', { id, enabled: false }),
      created.id,
    );
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.nextRunAt).toBeNull();

    const del = await page.evaluate((id) => window.marudesk.invoke('automations:delete', { id }), created.id);
    expect(del.ok).toBe(true);
    const afterDelete = await page.evaluate(() => window.marudesk.invoke('automations:list'));
    expect(afterDelete.some((a) => a.id === created.id)).toBe(false);
  } finally {
    await app.close();
  }
});

test('worktree: status reports a non-git workspace as ineligible', async () => {
  // A plain (non-git) folder so isolation status is reachable but not eligible.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-wt-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello\n');
  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      (root) => window.marudesk.invoke('workspaces:create', { name: 'Plain', roots: [{ name: 'Root', path: root }] }),
      dir,
    );
    const status = await page.evaluate(() => window.marudesk.invoke('git:worktree-status'));
    expect(status.active).toBe(false);
    // A non-git folder can't host a worktree, so isolation is not offered.
    expect(status.eligible).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
