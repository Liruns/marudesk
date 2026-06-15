import { getActive, getTab } from './state';
import { createAndActivateTab } from './tabs';
import { resolveAddressBarInput, searchBaseFor } from './url';
import { getSettingsSync } from '../settings';

/**
 * Address-bar navigation: resolve raw input to a safe URL (or a web search),
 * then load it in the active web view (opening one if the active tab is a
 * feature tab). The pure resolver lives in `./url` so `tabs.ts` can share it
 * for new-tab loads without a navigation↔tabs cycle.
 */

export { resolveAddressBarInput };

function resolveUrl(rawUrl: string): string | null {
  return resolveAddressBarInput(rawUrl, searchBaseFor(getSettingsSync().browser.searchEngine));
}

export async function navigateActive(rawUrl: string): Promise<void> {
  const url = resolveUrl(rawUrl);
  if (!url) return;
  const active = getActive();
  // Navigation always targets a web view. If the active tab is a feature tab
  // (or there is none), open a fresh web tab to host the navigation.
  const rec = active && active.view ? active : createAndActivateTab('web');
  if (!rec.view) return;
  await rec.view.webContents.loadURL(url);
}

/**
 * Navigate a SPECIFIC web tab in place, by id — the canvas path. Unlike
 * {@link navigateActive} it never changes the active tab or re-runs the web
 * layout, so loading a URL in one card leaves every other card (and the grid)
 * exactly where it is. No-op for a missing tab or a feature tab (no view).
 */
export async function navigateTab(tabId: string, rawUrl: string): Promise<void> {
  const url = resolveUrl(rawUrl);
  if (!url) return;
  const rec = getTab(tabId);
  if (!rec || !rec.view) return;
  await rec.view.webContents.loadURL(url);
}

/** Per-tab back/forward/reload for canvas cards (each card drives its own view). */
export function goBackTab(tabId: string): boolean {
  const rec = getTab(tabId);
  if (!rec || !rec.view) return false;
  const nh = rec.view.webContents.navigationHistory;
  if (!nh.canGoBack()) return false;
  nh.goBack();
  return true;
}

export function goForwardTab(tabId: string): boolean {
  const rec = getTab(tabId);
  if (!rec || !rec.view) return false;
  const nh = rec.view.webContents.navigationHistory;
  if (!nh.canGoForward()) return false;
  nh.goForward();
  return true;
}

export function reloadTab(tabId: string, ignoreCache?: boolean): boolean {
  const rec = getTab(tabId);
  if (!rec || !rec.view) return false;
  if (ignoreCache) rec.view.webContents.reloadIgnoringCache();
  else rec.view.webContents.reload();
  return true;
}
