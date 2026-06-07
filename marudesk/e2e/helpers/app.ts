import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
// e2e/helpers → marudesk/
const MARUDESK_ROOT = path.resolve(here, '..', '..');

export type LaunchedApp = { app: ElectronApplication; page: Page };

/** A throwaway userData dir so tests never read/write the developer's real config. */
export function makeTempUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'marudesk-e2e-'));
}

/**
 * Launch the built marudesk app and return the main window's page (the React
 * renderer). The page is where the chrome/tabs/panels live; the embedded
 * browser is a separate WebContentsView and isn't reachable through this page's
 * DOM. Always `await app.close()` in a finally.
 *
 * Runs against an isolated userData dir (so settings tests don't touch the real
 * config); pass a shared `userDataDir` to exercise persistence across launches.
 */
export async function launchApp(opts?: {
  userDataDir?: string;
  /** Keep the first-run home guide open (for tests that exercise the guide). */
  keepHomeGuide?: boolean;
}): Promise<LaunchedApp> {
  const userDataDir = opts?.userDataDir ?? makeTempUserDataDir();
  const app = await electron.launch({
    args: [
      path.join(MARUDESK_ROOT, 'dist-electron', 'main.mjs'),
      `--user-data-dir=${userDataDir}`,
    ],
    cwd: MARUDESK_ROOT,
  });
  // The splash window (electron/splash.ts) opens first, so firstWindow() can be
  // the splash — wait for the real renderer (index.html) instead.
  const page = await mainWindow(app);
  await page.waitForLoadState('domcontentloaded');
  // A fresh userData dir is always "first run", so the home guide auto-opens.
  // It occludes the launcher cards and one card mentions "Settings" (which
  // pollutes the activity-bar Settings locator), so dismiss it unless a test
  // explicitly wants to exercise the guide itself.
  if (opts?.keepHomeGuide !== true) {
    await dismissHomeGuide(page);
  }
  return { app, page };
}

/**
 * Dismiss the first-run home guide (HomeGuide) if it's showing. Best-effort: a
 * no-op for returning-user profiles where the guide was already marked seen.
 * Tests target the steady-state shell (launcher cards, unambiguous Settings),
 * which is what users see on every launch after the first.
 */
export async function dismissHomeGuide(page: Page): Promise<void> {
  // <section aria-label> exposes the "region" role with that accessible name.
  const guide = page.getByRole('region', {
    name: /What can you do|무엇을 할 수 있나요/,
  });
  try {
    await guide.waitFor({ state: 'visible', timeout: 4_000 });
  } catch {
    return; // Guide not shown (returning profile) — nothing to dismiss.
  }
  // Two controls share the "Got it" name (the header ✕ and the footer button);
  // either dismisses, so take the first.
  await page.getByRole('button', { name: /Got it|확인/ }).first().click();
  await guide.waitFor({ state: 'hidden', timeout: 5_000 });
}

/** Resolve the main renderer window (URL ends in index.html), not the splash. */
export async function mainWindow(app: ElectronApplication): Promise<Page> {
  const isMain = (p: Page): boolean => {
    try {
      return p.url().includes('index.html');
    } catch {
      return false;
    }
  };
  const existing = app.windows().find(isMain);
  if (existing) return existing;
  for (let i = 0; i < 80; i += 1) {
    const win = await app.waitForEvent('window').catch(() => null);
    if (win && isMain(win)) return win;
    const found = app.windows().find(isMain);
    if (found) return found;
  }
  return app.firstWindow();
}
