import { getActive, type TabRecord } from './state';
import { createAndActivateTab } from './tabs';

/**
 * Address-bar navigation: resolve the active web view (or open one) and load a
 * URL, applying the URL-vs-search heuristic.
 */

export async function navigateActive(rawUrl: string): Promise<void> {
  const active = getActive();
  // Navigation always targets a web view. If the active tab is a feature tab
  // (or there is none), open a fresh web tab to host the navigation.
  if (!active || !active.view) {
    const rec = createAndActivateTab('web');
    await loadUrlInto(rec, rawUrl);
    return;
  }
  await loadUrlInto(active, rawUrl);
}

async function loadUrlInto(rec: TabRecord, rawUrl: string): Promise<void> {
  if (!rec.view) return;
  let url = rawUrl.trim();
  if (!url) return;
  if (url.startsWith('file://')) {
    throw new Error('file:// navigation is not allowed');
  }
  if (
    !/^https?:\/\//i.test(url) &&
    url !== 'about:blank' &&
    !url.startsWith('about:')
  ) {
    // Heuristic: treat as URL if it has a dot or localhost; otherwise search.
    if (/^[\w.-]+(:\d+)?(\/.*)?$/.test(url) || url.startsWith('localhost')) {
      url = 'https://' + url;
    } else {
      url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
    }
  }
  await rec.view.webContents.loadURL(url);
}
