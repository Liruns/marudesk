import { test, expect, type ElectronApplication } from '@playwright/test';
import { launchApp } from './helpers/app';

test('browser menu: native popup selection navigates to a history item', async () => {
  const { app, page } = await launchApp();
  try {
    await page.evaluate(() =>
      window.marudesk.invoke('browser:tabs-new', { kind: 'web', url: 'about:blank' }),
    );
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
  }
});

test('browser view: resizes with the browser stage', async () => {
  const { app, page } = await launchApp();
  try {
    await page.evaluate(() =>
      window.marudesk.invoke('browser:tabs-new', { kind: 'web', url: 'about:blank' }),
    );

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
  }
});

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
  const views = await onScreenWebViews(app);
  return views.find((bounds) => boundsNear(bounds, stage)) ?? null;
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
