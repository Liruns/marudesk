import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers/app';

/**
 * Multi-workspace deck.
 *
 * The Mission Control redesign made the Task graph the only home and removed the
 * workspace-deck split, the "Workspace rail", the per-pane tab strips, and the
 * Explorer panel. The three UI flows this file used to cover —
 *   - "split panes can show different workspaces"
 *   - "Explorer opens files with the selected root identity"
 *   - "panes remember active tabs per workspace"
 * all drove that removed chrome, so they were deleted.
 *
 * The `workspaces:create` IPC handler survives (electron/workspace-registry.ts),
 * so this keeps a single logic-level round-trip that confirms a multi-root
 * workspace is created and given stable identities — no removed UI involved.
 */

function mkdirProject(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), `export const name = "${name}";\n`);
  return dir;
}

test('multi-workspace: workspaces:create round-trips a multi-root workspace', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-workspace-ui-'));
  const fe = mkdirProject(base, 'alpha-fe');
  const be = mkdirProject(base, 'alpha-be');
  const { app, page } = await launchApp();
  try {
    const record = await page.evaluate(
      (roots) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Project Alpha',
          roots: [
            { name: 'FE', path: roots.fe },
            { name: 'BE', path: roots.be },
          ],
        }),
      { fe, be },
    );

    expect(record).toBeTruthy();
    if (!record) return;
    expect(record.name).toBe('Project Alpha');
    expect(typeof record.id).toBe('string');
    expect(record.id.length).toBeGreaterThan(0);

    // Each named root keeps its label and gets its own stable id.
    const feRoot = record.roots.find((root) => root.name === 'FE');
    const beRoot = record.roots.find((root) => root.name === 'BE');
    expect(feRoot).toBeTruthy();
    expect(beRoot).toBeTruthy();
    expect(feRoot?.id).toBeTruthy();
    expect(beRoot?.id).toBeTruthy();
    expect(feRoot?.id).not.toBe(beRoot?.id);
  } finally {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
