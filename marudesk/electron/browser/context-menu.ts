import { Menu, clipboard, shell } from 'electron';
import { inspectElementAt } from './devtools';
import type { TabRecord } from './state';

/**
 * Browser-style right-click menu for a web tab. The tab-opener is injected
 * (`openWebTab`) rather than imported so this module stays a leaf of the tab
 * lifecycle — ./tabs wires its own `createAndActivateTab` in when it builds the
 * menu, avoiding a context-menu ↔ tabs import cycle.
 */
type OpenWebTab = (url: string) => void;

/**
 * Open a URL from a context-menu action the same way the window-open handler
 * does: http(s) opens in a new tab, anything else (mailto:, tel:, custom
 * schemes) is handed to the OS. Keeps menu navigation from funneling odd
 * schemes through the address-bar search heuristic.
 */
function openUrlInTabOrExternal(url: string, openWebTab: OpenWebTab): void {
  if (/^https?:\/\//i.test(url)) {
    openWebTab(url);
  } else {
    void shell.openExternal(url);
  }
}

/**
 * Build a browser-style right-click menu for a web tab. Mirrors the common
 * Chrome menu — link / image actions, edit roles inside form fields, a web
 * search for selected text, then navigation, then Inspect Element (which opens
 * the custom DevTools). `popup` without coords lands at the cursor, so no
 * view-offset math is needed.
 */
export function buildWebContextMenu(
  rec: TabRecord,
  params: Electron.ContextMenuParams,
  openWebTab: OpenWebTab,
): Menu {
  if (!rec.view) return Menu.buildFromTemplate([]);
  const wc = rec.view.webContents;
  const items: Electron.MenuItemConstructorOptions[] = [];
  const sep: Electron.MenuItemConstructorOptions = { type: 'separator' };

  if (params.linkURL) {
    const linkURL = params.linkURL;
    items.push(
      {
        label: 'Open Link in New Tab',
        click: () => openUrlInTabOrExternal(linkURL, openWebTab),
      },
      { label: 'Copy Link Address', click: () => clipboard.writeText(linkURL) },
      sep,
    );
  }

  // Only act on image sources the page could legitimately have fetched —
  // http(s)/data/blob. This keeps `downloadURL`/`copyImageAt` from reaching a
  // `file://` resource: `will-navigate` blocks file:// for navigation, but a
  // download would otherwise bypass that guard.
  if (
    params.mediaType === 'image' &&
    /^(https?|data|blob):/i.test(params.srcURL)
  ) {
    const srcURL = params.srcURL;
    if (/^https?:\/\//i.test(srcURL)) {
      items.push({
        label: 'Open Image in New Tab',
        click: () => openWebTab(srcURL),
      });
    }
    items.push(
      { label: 'Save Image As…', click: () => wc.downloadURL(srcURL) },
      { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(srcURL) },
      sep,
    );
  }

  if (params.isEditable) {
    items.push(
      { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
      sep,
      { label: 'Select All', role: 'selectAll' },
    );
    return Menu.buildFromTemplate(items);
  }

  if (params.selectionText.trim()) {
    const q = params.selectionText.trim();
    const shortQ = q.length > 40 ? q.slice(0, 40) + '…' : q;
    items.push(
      { label: 'Copy', role: 'copy' },
      {
        label: `Search the web for “${shortQ}”`,
        click: () =>
          openWebTab(
            'https://www.google.com/search?q=' + encodeURIComponent(q),
          ),
      },
      sep,
    );
  }

  const nh = wc.navigationHistory;
  items.push(
    { label: 'Back', enabled: nh.canGoBack(), click: () => nh.goBack() },
    { label: 'Forward', enabled: nh.canGoForward(), click: () => nh.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    sep,
    { label: 'Copy Page URL', click: () => clipboard.writeText(wc.getURL()) },
    { label: 'Select All', role: 'selectAll' },
    sep,
    {
      label: 'Inspect Element',
      click: () => {
        void inspectElementAt(rec, params.x, params.y);
      },
    },
  );

  return Menu.buildFromTemplate(items);
}
