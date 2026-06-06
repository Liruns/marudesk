import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './helpers/app';

type ProjectFixture = {
  readonly base: string;
  readonly alphaFe: string;
  readonly alphaBe: string;
  readonly betaFe: string;
  readonly betaBe: string;
};

function mkdirProject(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), `export const name = "${name}";\n`);
  fs.writeFileSync(path.join(dir, 'src', `${name}.tsx`), `export const project = "${name}";\n`);
  return dir;
}

function createProjects(): ProjectFixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-workspace-ui-'));
  return {
    base,
    alphaFe: mkdirProject(base, 'alpha-fe'),
    alphaBe: mkdirProject(base, 'alpha-be'),
    betaFe: mkdirProject(base, 'beta-fe'),
    betaBe: mkdirProject(base, 'beta-be'),
  };
}

test('multi-workspace deck: split panes can show different workspaces', async () => {
  const fixture = createProjects();
  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      async ({ alphaFe, alphaBe, betaFe, betaBe }) => {
        await window.marudesk.invoke('workspaces:create', {
          name: 'Project Alpha',
          roots: [
            { name: 'FE', path: alphaFe },
            { name: 'BE', path: alphaBe },
          ],
        });
        await window.marudesk.invoke('workspaces:create', {
          name: 'Project Beta',
          roots: [
            { name: 'FE', path: betaFe },
            { name: 'BE', path: betaBe },
          ],
        });
      },
      fixture,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('navigation', { name: 'Workspace rail' })).toBeVisible();
    await expect(page.getByText('Project Beta', { exact: true })).toBeVisible();
    const explorer = page.getByRole('complementary', { name: 'Explorer' });
    await expect(explorer.getByText('No folder open')).not.toBeVisible();
    await expect(explorer.getByRole('button', { name: 'Use root FE' })).toBeVisible();
    await expect(explorer.getByRole('button', { name: 'Use root BE' })).toBeVisible();

    await explorer.getByRole('button', { name: 'Use root BE' }).click();
    await expect(explorer.getByText('Project Beta / BE')).toBeVisible();

    await page.getByRole('button', { name: 'Split workspace right' }).click();
    await page.getByRole('button', { name: 'Workspace Project Alpha' }).click();

    await expect(page.getByText('Project Alpha', { exact: true })).toBeVisible();
    await expect(page.getByText('Project Beta', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Peek Explorer' })).toHaveCount(2);
  } finally {
    await app.close();
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('multi-workspace deck: Explorer opens files with the selected root identity', async () => {
  const fixture = createProjects();
  const { app, page } = await launchApp();
  try {
    const record = await page.evaluate(
      ({ alphaFe, alphaBe }) =>
        window.marudesk.invoke('workspaces:create', {
          name: 'Project Alpha',
          roots: [
            { name: 'FE', path: alphaFe },
            { name: 'BE', path: alphaBe },
          ],
        }),
      fixture,
    );
    const beRoot = record.roots.find((root) => root.name === 'BE');
    expect(beRoot).toBeTruthy();
    if (!beRoot) return;

    await page.reload({ waitUntil: 'domcontentloaded' });
    const explorer = page.getByRole('complementary', { name: 'Explorer' });
    await explorer.getByRole('button', { name: 'Use root BE' }).click();
    await expect(explorer.getByText('Project Alpha / BE')).toBeVisible();

    // The file tree is rendered by @pierre/trees as a `tree` of `treeitem`s
    // (inside an open shadow root, which Playwright pierces). Clicking the `src`
    // directory expands it; clicking `App.tsx` opens it in the editor.
    await explorer.getByRole('treeitem', { name: 'src' }).click();
    await explorer.getByRole('treeitem', { name: 'App.tsx' }).click();

    const snapshot = await page.evaluate(() => window.marudesk.invoke('browser:tabs-snapshot'));
    const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);

    expect(active?.kind).toBe('editor');
    expect(active?.workspaceId).toBe(record.id);
    expect(active?.editorFile?.rootId).toBe(beRoot.id);
    expect(active?.editorFile?.path).toBe('src/App.tsx');
  } finally {
    await app.close();
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('multi-workspace deck: panes remember active tabs per workspace', async () => {
  const fixture = createProjects();
  const { app, page } = await launchApp();
  try {
    await page.evaluate(
      async ({ alphaFe, alphaBe, betaFe, betaBe }) => {
        const alpha = await window.marudesk.invoke('workspaces:create', {
          name: 'Project Alpha',
          roots: [
            { name: 'FE', path: alphaFe },
            { name: 'BE', path: alphaBe },
          ],
        });
        const beta = await window.marudesk.invoke('workspaces:create', {
          name: 'Project Beta',
          roots: [
            { name: 'FE', path: betaFe },
            { name: 'BE', path: betaBe },
          ],
        });
        const alphaRoot = alpha.roots[0];
        const betaRoot = beta.roots[0];
        if (!alphaRoot || !betaRoot) throw new Error('missing fixture roots');
        await window.marudesk.invoke('browser:tabs-new', {
          kind: 'editor',
          workspaceId: alpha.id,
          file: { workspaceId: alpha.id, rootId: alphaRoot.id, path: 'src/App.tsx' },
        });
        await window.marudesk.invoke('browser:tabs-new', {
          kind: 'editor',
          workspaceId: alpha.id,
          file: { workspaceId: alpha.id, rootId: alphaRoot.id, path: 'src/alpha-fe.tsx' },
        });
        await window.marudesk.invoke('browser:tabs-new', {
          kind: 'editor',
          workspaceId: beta.id,
          file: { workspaceId: beta.id, rootId: betaRoot.id, path: 'src/App.tsx' },
        });
        await window.marudesk.invoke('browser:tabs-new', {
          kind: 'editor',
          workspaceId: beta.id,
          file: { workspaceId: beta.id, rootId: betaRoot.id, path: 'src/beta-fe.tsx' },
        });
      },
      fixture,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Split workspace right' }).click();
    await page.getByRole('button', { name: 'Workspace Project Alpha' }).click();

    const alphaPane = page.getByRole('region', { name: 'Project Alpha' });
    const betaPane = page.getByRole('region', { name: 'Project Beta' });
    const alphaApp = alphaPane.getByRole('tab', { name: 'App.tsx' });
    const betaApp = betaPane.getByRole('tab', { name: 'App.tsx' });

    await alphaApp.click();
    await betaApp.click();

    await expect(alphaApp).toHaveAttribute('aria-selected', 'true');
    await expect(betaApp).toHaveAttribute('aria-selected', 'true');
  } finally {
    await app.close();
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});
