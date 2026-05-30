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
}): Promise<LaunchedApp> {
  const userDataDir = opts?.userDataDir ?? makeTempUserDataDir();
  const app = await electron.launch({
    args: [
      path.join(MARUDESK_ROOT, 'dist-electron', 'main.mjs'),
      `--user-data-dir=${userDataDir}`,
    ],
    cwd: MARUDESK_ROOT,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}
