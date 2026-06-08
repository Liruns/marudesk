import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * Spec lifecycle storage (docs/runtime-agent-absorption-2026-06.md §3.10):
 * per-workspace spec docs + task lists under .marudesk/specs/*.json. Verify the
 * CRUD IPC end-to-end (create → list → update preserves id/createdAt → delete).
 */
test('specs: create, update, and delete round-trip', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-spec-'));
  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      (root) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Spec',
          roots: [{ name: 'Root', path: root }],
        }),
      ws,
    );

    const created = await page.evaluate(() =>
      window.marudesk.invoke('specs:save', {
        title: 'Login flow',
        body: '## Goal\nSign in with email.',
        tasks: [
          { id: 't1', text: 'Build form', done: false },
          { id: 't2', text: 'Wire submit', done: true },
        ],
      }),
    );
    expect(created.id).toMatch(/^spec-/);
    expect(created.tasks).toHaveLength(2);
    expect(created.status).toBe('draft');

    const list = await page.evaluate(() => window.marudesk.invoke('specs:list'));
    expect(list.map((s) => s.id)).toContain(created.id);

    // Update keeps the same id + createdAt, bumps updatedAt.
    const updated = await page.evaluate(
      (spec) =>
        window.marudesk.invoke('specs:save', {
          id: spec.id,
          title: 'Login flow v2',
          body: spec.body,
          status: 'review',
          tasks: spec.tasks.map((t) => ({ ...t, done: true })),
        }),
      created,
    );
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.title).toBe('Login flow v2');
    expect(updated.status).toBe('review');
    expect(updated.tasks.every((t) => t.done)).toBe(true);

    // The file really exists on disk under .marudesk/specs.
    expect(fs.existsSync(path.join(ws, '.marudesk', 'specs', `${created.id}.json`))).toBe(true);

    expect(await page.evaluate((id) => window.marudesk.invoke('specs:delete', { id }), created.id)).toBe(true);
    const after = await page.evaluate(() => window.marudesk.invoke('specs:list'));
    expect(after.map((s) => s.id)).not.toContain(created.id);
  } finally {
    await app.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
