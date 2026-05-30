import { getActive } from './state';
import { createAndActivateTab } from './tabs';

/**
 * Address-bar navigation: resolve raw input to a safe URL (or a web search),
 * then load it in the active web view (opening one if the active tab is a
 * feature tab).
 */

export async function navigateActive(rawUrl: string): Promise<void> {
  const url = resolveAddressBarInput(rawUrl);
  if (!url) return;
  const active = getActive();
  // Navigation always targets a web view. If the active tab is a feature tab
  // (or there is none), open a fresh web tab to host the navigation.
  const rec = active && active.view ? active : createAndActivateTab('web');
  if (!rec.view) return;
  await rec.view.webContents.loadURL(url);
}

/**
 * Resolve raw address-bar input to a URL safe to load, or '' to ignore.
 *
 *  - http(s) and `about:blank` load as-is.
 *  - Any OTHER explicit scheme (file:, javascript:, data:, blob:, chrome:,
 *    devtools:, view-source:, other about:, ftp:) is NEVER loaded — it routes
 *    to a web search, so typing one can't execute script or reach local
 *    resources / browser internals.
 *  - Schemeless input that looks like host[:port][/path] (or localhost) becomes
 *    https://…; anything else becomes a web search.
 *
 * Pure and Electron-free so the policy is unit-testable in isolation.
 */
export function resolveAddressBarInput(rawInput: string): string {
  const input = rawInput.trim();
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;
  if (input === 'about:blank') return input;
  // Refuse to load dangerous / internal schemes — fall through to a search.
  if (
    /^(file|javascript|data|blob|chrome|devtools|view-source|about|ftp):/i.test(
      input,
    )
  ) {
    return searchUrl(input);
  }
  // Schemeless: looks like a host (has a dot/port/path) or localhost → https.
  if (/^[\w.-]+(:\d+)?(\/.*)?$/.test(input) || input.startsWith('localhost')) {
    return 'https://' + input;
  }
  return searchUrl(input);
}

function searchUrl(query: string): string {
  return 'https://www.google.com/search?q=' + encodeURIComponent(query);
}
