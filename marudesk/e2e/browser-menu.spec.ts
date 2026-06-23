import { createServer } from 'node:http';
import { test, expect, type ElectronApplication } from '@playwright/test';
import { launchApp } from './helpers/app';
import { openInstrumentFromTask, seedGraph } from './helpers/mission-control';
import { WEB_CARD_GAP } from '../shared/browser';

/**
 * Browser menu + browser-view sizing, reached through Mission Control. The classic
 * tab strip is gone: a web surface now opens as a full-area **instrument** summoned
 * from a Task's `url` resource. So each test seeds a one-task graph whose output is
 * a clickable `page` chip, opens it via the dock inspector, and then exercises the
 * live web instrument's toolbar menu / stage resize. Opening the instrument also
 * makes its WebContentsView the visible/active one, so `browser:navigate` and the
 * stage ResizeObserver act on it. The native popup itself is stubbed at the IPC
 * boundary (no OS menu in CI).
 */

function taskWithPage(url: string) {
  return {
    id: 't1',
    title: 'Open the page',
    outputs: [{ id: 'r1', kind: 'url' as const, uri: url, label: 'page' }],
  };
}

test('browser menu: native popup selection navigates to a history item', async () => {
  const server = await startBlankServer();
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, { tasks: [taskWithPage(server.url)] });
    await openInstrumentFromTask(page, 't1', 'page');

    const menuButton = page.getByRole('button', { name: 'Browser menu' });
    await expect(menuButton).toBeVisible();

    await installBrowserMenuIpcStubs(app);
    await menuButton.click();

    await expect.poll(() => capturedBrowserMenuSummary(app)).toEqual({
      hasHistoryItem: true,
      downloadsDisabled: true,
      navigatedUrl: 'https://example.com/docs',
    });
  } finally {
    await app.close();
    await server.close();
  }
});

test('browser view: resizes with the browser stage', async () => {
  const server = await startBlankServer();
  const { app, page } = await launchApp();
  try {
    await seedGraph(page, { tasks: [taskWithPage(server.url)] });
    await openInstrumentFromTask(page, 't1', 'page');

    const stage = page.getByLabel('Browser stage');
    await expect(stage).toBeVisible();
    const beforeStage = await stage.boundingBox();
    if (!beforeStage) throw new Error('no browser stage box');

    await expect
      .poll(async () => hasBrowserViewMatchingStage(app, beforeStage))
      .toBe(true);

    const beforeView = await firstBrowserViewMatchingStage(app, beforeStage);
    if (!beforeView) throw new Error('no browser view matching the initial stage');

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no BrowserWindow');
      const [width, height] = win.getSize();
      win.setSize(width > 900 ? width - 173 : width + 173, height > 700 ? height - 97 : height + 97);
    });

    await expect
      .poll(async () => {
        const afterStage = await stage.boundingBox();
        if (!afterStage) return '';
        const afterView = await firstBrowserViewMatchingStage(app, afterStage);
        return afterView ? `${afterView.width}x${afterView.height}` : '';
      })
      .not.toBe(`${beforeView.width}x${beforeView.height}`);
  } finally {
    await app.close();
    await server.close();
  }
});

async function startBlankServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><body><h1>page</h1></body>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('blank server did not bind a port');
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function installBrowserMenuIpcStubs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & {
      __browserMenuPopupPayloads?: unknown[];
      __browserMenuNavigations?: string[];
    };
    state.__browserMenuPopupPayloads = [];
    state.__browserMenuNavigations = [];

    ipcMain.removeHandler('history:recent');
    ipcMain.handle('history:recent', () => [
      {
        url: 'https://example.com/docs',
        title: 'Example Docs',
        visitCount: 3,
        lastVisit: 1_700_000_000_000,
      },
    ]);

    ipcMain.removeHandler('browser:popup-menu');
    ipcMain.handle('browser:popup-menu', (_event, payload) => {
      state.__browserMenuPopupPayloads?.push(payload);
      return 'history:0';
    });

    ipcMain.removeHandler('browser:navigate');
    ipcMain.handle('browser:navigate', (_event, url) => {
      if (typeof url === 'string') state.__browserMenuNavigations?.push(url);
      return undefined;
    });
  });
}

type BrowserMenuSummary = {
  readonly hasHistoryItem: boolean;
  readonly downloadsDisabled: boolean;
  readonly navigatedUrl: string;
};

type ViewBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

async function capturedBrowserMenuSummary(app: ElectronApplication): Promise<BrowserMenuSummary> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __browserMenuPopupPayloads?: unknown[];
      __browserMenuNavigations?: string[];
    };
    const payload = state.__browserMenuPopupPayloads?.[0];
    const items =
      payload && typeof payload === 'object' && 'items' in payload && Array.isArray(payload.items)
        ? payload.items
        : [];
    return {
      hasHistoryItem: items.some(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          'id' in item &&
          'label' in item &&
          item.id === 'history:0' &&
          item.label === 'Example Docs',
      ),
      downloadsDisabled: items.some(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          'id' in item &&
          'enabled' in item &&
          item.id === 'downloads' &&
          item.enabled === false,
      ),
      navigatedUrl: state.__browserMenuNavigations?.[0] ?? '',
    };
  });
}

async function firstBrowserViewMatchingStage(
  app: ElectronApplication,
  stage: ViewBounds,
): Promise<ViewBounds | null> {
  // The Arc floating card insets the native view by WEB_CARD_GAP on every side,
  // so the view tracks the stage rect minus that gap (not the stage rect itself).
  const expected: ViewBounds = {
    x: stage.x + WEB_CARD_GAP,
    y: stage.y + WEB_CARD_GAP,
    width: stage.width - WEB_CARD_GAP * 2,
    height: stage.height - WEB_CARD_GAP * 2,
  };
  const views = await onScreenWebViews(app);
  return views.find((bounds) => boundsNear(bounds, expected)) ?? null;
}

async function hasBrowserViewMatchingStage(
  app: ElectronApplication,
  stage: ViewBounds,
): Promise<boolean> {
  return (await firstBrowserViewMatchingStage(app, stage)) !== null;
}

async function onScreenWebViews(app: ElectronApplication): Promise<readonly ViewBounds[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return [];
    return (win.contentView.children ?? [])
      .map((view) => view.getBounds())
      .filter((bounds) => bounds.x > -1000 && bounds.width > 20 && bounds.height > 20);
  });
}

function boundsNear(actual: ViewBounds, expected: ViewBounds): boolean {
  return (
    close(actual.x, expected.x) &&
    close(actual.y, expected.y) &&
    close(actual.width, expected.width) &&
    close(actual.height, expected.height)
  );
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 6;
}
