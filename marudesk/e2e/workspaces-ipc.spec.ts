import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers/app';

type FixtureRoots = {
  readonly base: string;
  readonly fe: string;
  readonly be: string;
};

function createFixtureRoots(): FixtureRoots {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-workspaces-'));
  const fe = path.join(base, 'project-a-fe');
  const be = path.join(base, 'project-a-be');
  fs.mkdirSync(path.join(fe, 'src'), { recursive: true });
  fs.mkdirSync(path.join(be, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fe, 'src', 'App.tsx'), 'export const app = "fe";\n');
  fs.writeFileSync(path.join(be, 'src', 'App.tsx'), 'export const app = "be";\n');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside\n');
  return { base, fe, be };
}

test('workspaces IPC: creates a multi-root workspace and reads root-qualified files', async () => {
  const roots = createFixtureRoots();
  const { app, page } = await launchApp();
  try {
    const record = await page.evaluate(
      ({ fe, be }) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Project A',
          roots: [
            { name: 'FE', path: fe },
            { name: 'BE', path: be },
          ],
        }),
      { fe: roots.fe, be: roots.be },
    );

    expect(record.name).toBe('Project A');
    expect(record.roots.map((root) => root.name)).toEqual(['FE', 'BE']);

    const snapshot = await page.evaluate(() => window.marudesk.invoke('workspaces:list'));
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.activeWorkspaceId).toBe(record.id);

    const feRoot = record.roots.find((root) => root.name === 'FE');
    const beRoot = record.roots.find((root) => root.name === 'BE');
    expect(feRoot).toBeTruthy();
    expect(beRoot).toBeTruthy();
    if (!feRoot || !beRoot) return;

    const feRead = await page.evaluate(
      (file) => window.marudesk.invoke('workspaces:read-file', file),
      { workspaceId: record.id, rootId: feRoot.id, path: 'src/App.tsx' },
    );
    const beRead = await page.evaluate(
      (file) => window.marudesk.invoke('workspaces:read-file', file),
      { workspaceId: record.id, rootId: beRoot.id, path: 'src/App.tsx' },
    );

    expect(feRead).toEqual({
      ok: true,
      kind: 'text',
      content: 'export const app = "fe";\n',
    });
    expect(beRead).toEqual({
      ok: true,
      kind: 'text',
      content: 'export const app = "be";\n',
    });
  } finally {
    await app.close();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test('workspaces IPC: re-listing a root reuses its workspace instead of duplicating', async () => {
  const roots = createFixtureRoots();
  const { app, page } = await launchApp();
  try {
    const counts = await page.evaluate(async ({ fe }) => {
      await window.marudesk.invoke('workspaces:create', {
        name: 'Project A',
        roots: [{ name: 'FE', path: fe }],
      });
      const total = (): Promise<number> =>
        window.marudesk
          .invoke('workspaces:list')
          .then((snapshot) => snapshot.workspaces.length);
      const created = await total();
      // Legacy single-root bridge (Explorer Refresh / reopen a recent). Each
      // call must refresh the existing workspace in place, never pile a fresh
      // duplicate onto the rail.
      await window.marudesk.invoke('workspace:list', fe);
      await window.marudesk.invoke('workspace:list', fe);
      const relisted = await total();
      return { created, relisted };
    }, { fe: roots.fe });

    expect(counts.created).toBe(1);
    expect(counts.relisted).toBe(1);
  } finally {
    await app.close();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test('workspaces IPC: rejects traversal outside the selected root', async () => {
  const roots = createFixtureRoots();
  const { app, page } = await launchApp();
  try {
    const record = await page.evaluate(
      ({ fe }) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Project A',
          roots: [{ name: 'FE', path: fe }],
        }),
      { fe: roots.fe },
    );
    const root = record.roots[0];
    expect(root).toBeTruthy();
    if (!root) return;

    const message = await page.evaluate(
      async (file) => {
        try {
          await window.marudesk.invoke('workspaces:read-file', file);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
      { workspaceId: record.id, rootId: root.id, path: '../outside.txt' },
    );

    expect(message).toContain('marudesk:');
  } finally {
    await app.close();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test('workspaces IPC: tabs carry workspace ownership', async () => {
  const roots = createFixtureRoots();
  const { app, page } = await launchApp();
  try {
    const record = await page.evaluate(
      ({ fe }) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Project A',
          roots: [{ name: 'FE', path: fe }],
        }),
      { fe: roots.fe },
    );

    const tabId = await page.evaluate(
      (workspaceId) =>
        window.marudesk.invoke('browser:tabs-new', {
          kind: 'home',
          workspaceId,
        }),
      record.id,
    );
    const snapshot = await page.evaluate(() => window.marudesk.invoke('browser:tabs-snapshot'));
    const tab = snapshot.tabs.find((entry) => entry.id === tabId);

    expect(tab?.workspaceId).toBe(record.id);
  } finally {
    await app.close();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test('workspaces IPC: closing the active tab stays inside its workspace tab set', async () => {
  const roots = createFixtureRoots();
  const { app, page } = await launchApp();
  try {
    const record = await page.evaluate(
      ({ fe }) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Project A',
          roots: [{ name: 'FE', path: fe }],
        }),
      { fe: roots.fe },
    );
    const other = await page.evaluate(
      ({ be }) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Project B',
          roots: [{ name: 'BE', path: be }],
        }),
      { be: roots.be },
    );

    const firstProjectTab = await page.evaluate(
      (workspaceId) =>
        window.marudesk.invoke('browser:tabs-new', {
          kind: 'home',
          workspaceId,
        }),
      record.id,
    );
    const tabToClose = await page.evaluate(
      (workspaceId) =>
        window.marudesk.invoke('browser:tabs-new', {
          kind: 'settings',
          workspaceId,
        }),
      record.id,
    );
    await page.evaluate(
      (workspaceId) =>
        window.marudesk.invoke('browser:tabs-new', {
          kind: 'home',
          workspaceId,
        }),
      other.id,
    );

    await page.evaluate((tabId) => window.marudesk.invoke('browser:tabs-activate', tabId), tabToClose);
    await page.evaluate((tabId) => window.marudesk.invoke('browser:tabs-close', tabId), tabToClose);

    const snapshot = await page.evaluate(() => window.marudesk.invoke('browser:tabs-snapshot'));
    const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);

    expect(snapshot.activeTabId).toBe(firstProjectTab);
    expect(active?.workspaceId).toBe(record.id);
  } finally {
    await app.close();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test('workspaces IPC: editor tabs preserve root-qualified file identity', async () => {
  const roots = createFixtureRoots();
  const { app, page } = await launchApp();
  try {
    const record = await page.evaluate(
      ({ fe, be }) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Project A',
          roots: [
            { name: 'FE', path: fe },
            { name: 'BE', path: be },
          ],
        }),
      { fe: roots.fe, be: roots.be },
    );
    const feRoot = record.roots.find((root) => root.name === 'FE');
    const beRoot = record.roots.find((root) => root.name === 'BE');
    expect(feRoot).toBeTruthy();
    expect(beRoot).toBeTruthy();
    if (!feRoot || !beRoot) return;

    const fileA = { workspaceId: record.id, rootId: feRoot.id, path: 'src/App.tsx' };
    const fileB = { workspaceId: record.id, rootId: beRoot.id, path: 'src/App.tsx' };
    const tabA = await page.evaluate(
      (file) => window.marudesk.invoke('browser:tabs-new', { kind: 'editor', file }),
      fileA,
    );
    const tabB = await page.evaluate(
      (file) => window.marudesk.invoke('browser:tabs-new', { kind: 'editor', file }),
      fileB,
    );
    const snapshot = await page.evaluate(() => window.marudesk.invoke('browser:tabs-snapshot'));
    const editors = snapshot.tabs.filter((tab) => tab.id === tabA || tab.id === tabB);

    expect(editors).toHaveLength(2);
    expect(editors.map((tab) => tab.editorFile?.rootId).sort()).toEqual(
      [feRoot.id, beRoot.id].sort(),
    );
    expect(editors.map((tab) => tab.filePath)).toEqual(['src/App.tsx', 'src/App.tsx']);
  } finally {
    await app.close();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test('workspaces IPC: reopened editor tabs keep their root-qualified file identity', async () => {
  const roots = createFixtureRoots();
  const { app, page } = await launchApp();
  try {
    const record = await page.evaluate(
      ({ fe, be }) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Project A',
          roots: [
            { name: 'FE', path: fe },
            { name: 'BE', path: be },
          ],
        }),
      { fe: roots.fe, be: roots.be },
    );
    const beRoot = record.roots.find((root) => root.name === 'BE');
    expect(beRoot).toBeTruthy();
    if (!beRoot) return;

    const file = { workspaceId: record.id, rootId: beRoot.id, path: 'src/App.tsx' };
    const tabId = await page.evaluate(
      (editorFile) => window.marudesk.invoke('browser:tabs-new', { kind: 'editor', file: editorFile }),
      file,
    );

    await page.evaluate((id) => window.marudesk.invoke('browser:tabs-close', id), tabId);
    await page.evaluate(() => window.marudesk.invoke('browser:tabs-reopen'));

    const snapshot = await page.evaluate(() => window.marudesk.invoke('browser:tabs-snapshot'));
    const reopened = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);

    expect(reopened?.kind).toBe('editor');
    expect(reopened?.workspaceId).toBe(record.id);
    expect(reopened?.editorFile).toEqual(file);
  } finally {
    await app.close();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});

test('workspaces IPC: active root drives legacy workspace file channels', async () => {
  const roots = createFixtureRoots();
  const { app, page } = await launchApp();
  try {
    const record = await page.evaluate(
      ({ fe, be }) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Project A',
          roots: [
            { name: 'FE', path: fe },
            { name: 'BE', path: be },
          ],
        }),
      { fe: roots.fe, be: roots.be },
    );
    const beRoot = record.roots.find((root) => root.name === 'BE');
    expect(beRoot).toBeTruthy();
    if (!beRoot) return;

    await page.evaluate(
      ({ workspaceId, rootId }) =>
        window.marudesk.invoke('workspaces:set-active-root', { workspaceId, rootId }),
      { workspaceId: record.id, rootId: beRoot.id },
    );
    const read = await page.evaluate(() =>
      window.marudesk.invoke('workspace:read-file', 'src/App.tsx'),
    );

    expect(read).toEqual({
      ok: true,
      kind: 'text',
      content: 'export const app = "be";\n',
    });
  } finally {
    await app.close();
    fs.rmSync(roots.base, { recursive: true, force: true });
  }
});
