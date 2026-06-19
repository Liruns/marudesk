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
  /**
   * Which stage surface to start on. Maru defaults to the infinite **canvas**,
   * but most specs drive the classic tab strip / split grid, so tests default to
   * `'classic'`. The canvas spec opts into `'canvas'`; the Work OS spec into
   * `'workgraph'`.
   */
  surface?: 'classic' | 'canvas' | 'workgraph';
}): Promise<LaunchedApp> {
  const userDataDir = opts?.userDataDir ?? makeTempUserDataDir();
  const app = await electron.launch({
    args: [
      path.join(MARUDESK_ROOT, 'dist-electron', 'main.mjs'),
      `--user-data-dir=${userDataDir}`,
      // Chromium's sandbox can't initialize as uid 0 (CI/root containers); it's a
      // no-op on a normal dev login where the sandbox works.
      ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
    ],
    cwd: MARUDESK_ROOT,
    // Close-to-tray (the default) would turn window close into hide and leave
    // the process running past app.close(); tests need close = exit. Also keeps
    // OS tray icons from piling up during a run.
    env: { ...process.env, MARUDESK_DISABLE_TRAY: '1' },
  });
  // The splash window (electron/splash.ts) opens first, so firstWindow() can be
  // the splash — wait for the real renderer (index.html) instead.
  const page = await mainWindow(app);
  await page.waitForLoadState('domcontentloaded');
  // Seed the persisted surface mode and reload so the Shell renders it. Maru
  // ships canvas-first, but the classic-shell specs assume the tab strip / grid
  // on launch, so tests default to 'classic' unless they opt into the canvas.
  const surface = opts?.surface ?? 'classic';
  await page.evaluate((mode) => localStorage.setItem('maru.surface', mode), surface);
  await page.reload();
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

/**
 * Drag a canvas card's header by a screen-space offset (dx, dy).
 *
 * Uses Playwright's `locator.dragTo` rather than raw `page.mouse.down/move/up`:
 * the card header drag arms a `setPointerCapture` gesture and only commits the
 * new position to the store on a matching `pointerup`. Raw `page.mouse` events
 * don't carry a stable pointerId in this Electron+Playwright harness, so the
 * captured pointerup is dropped — the card paints to the moved spot but the
 * store keeps the old position. `dragTo` preserves the pointerId, so the move
 * commits (matches the real-mouse behavior).
 */
export async function dragCanvasCardHeader(
  page: Page,
  headerIndex: number,
  dx: number,
  dy: number,
): Promise<void> {
  const header = page.locator('[data-card-header]').nth(headerIndex);
  const hb = await header.boundingBox();
  const canvas = page.locator('[aria-label="Canvas"]');
  const cb = await canvas.boundingBox();
  if (!hb || !cb) throw new Error('missing card-header / canvas box');
  const sx = hb.width * 0.4;
  const sy = hb.height / 2;
  await header.dragTo(canvas, {
    sourcePosition: { x: sx, y: sy },
    targetPosition: { x: hb.x + sx + dx - cb.x, y: hb.y + sy + dy - cb.y },
  });
}

/**
 * Wire a connection from one card onto another. Drags from the source card's
 * TOP-edge port (which faces empty space above the card) to avoid the
 * facing-port occlusion you hit with adjacent cards' right/left ports — when two
 * cards sit side by side, the higher card's near-edge port covers the other's,
 * so a raw drag from the occluded port lands on the wrong card. The drop target
 * is geometry-hit-tested by the canvas, so any port side reaches `target`.
 */
export async function connectCanvasCards(
  page: Page,
  source: ReturnType<Page['locator']>,
  target: ReturnType<Page['locator']>,
): Promise<void> {
  await source.getByRole('button', { name: 'Connect from top edge' }).dragTo(target);
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
