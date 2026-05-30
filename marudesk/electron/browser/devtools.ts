import { detachCdp } from './cdp';
import type { TabRecord } from './state';

/**
 * Escape hatch to the built-in Chromium DevTools (detached window).
 *
 * Our own CDP-backed React dock (electron/browser/cdp.ts + the renderer's
 * features/devtools) is the day-to-day inspector. But a single webContents
 * allows only ONE CDP client, so the built-in DevTools and our debugger are
 * mutually exclusive on the same page. We keep the built-in DevTools reachable
 * — for device emulation, network throttling, and the Sources debugger our
 * panels don't have yet (see docs/custom-devtools-design.md §11.1/§14) — by
 * detaching our client first. Selected via the `'chrome'` dock setting.
 *
 * The app-level Electron DevTools (main.ts, dev only) is a different
 * webContents and unaffected by any of this.
 */

export function openChromeDevtools(rec: TabRecord): void {
  if (!rec.view) return;
  // Single CDP client per page: drop our debugger before the built-in DevTools
  // grabs it. The renderer's session sees the 'detach' and resets to idle.
  detachCdp(rec);
  rec.chromeDevtoolsOpen = true;
  rec.view.webContents.openDevTools({ mode: 'detach' });
}

export function closeChromeDevtools(rec: TabRecord): void {
  rec.chromeDevtoolsOpen = false;
  try {
    rec.view?.webContents.closeDevTools();
  } catch {
    // contents already destroyed — ignore
  }
}

/**
 * Toggle the built-in DevTools for a tab. `isDevToolsOpened()` is the source of
 * truth (so a window the user closed manually re-opens on the next toggle); the
 * `chromeDevtoolsOpen` flag is just a hint for teardown.
 */
export function toggleChromeDevtools(rec: TabRecord): void {
  if (!rec.view) return;
  if (rec.view.webContents.isDevToolsOpened()) {
    closeChromeDevtools(rec);
  } else {
    openChromeDevtools(rec);
  }
}
