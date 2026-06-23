import { Menu, clipboard } from 'electron';
import { getHost, type TabRecord } from './state';
import { openExternalUrl } from '../safe-open';
import type { WebContextMenuLabels } from '../../shared/browser';

/**
 * English defaults — used until the renderer pushes its localized labels (and as
 * the per-field fallback when an untrusted push omits or mistypes a field). The
 * renderer is the single i18n source of truth; see {@link setWebContextMenuLabels}.
 */
const DEFAULT_LABELS: WebContextMenuLabels = {
  openLinkNewTab: 'Open Link in New Tab',
  copyLinkAddress: 'Copy Link Address',
  openImageNewTab: 'Open Image in New Tab',
  saveImage: 'Save Image',
  copyImage: 'Copy Image',
  copyImageAddress: 'Copy Image Address',
  addToDictionary: 'Add to Dictionary',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  searchWeb: 'Search the web for “{q}”',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  copyPageUrl: 'Copy Page URL',
  inspectElement: 'Inspect Element',
};

let labels: WebContextMenuLabels = DEFAULT_LABELS;

/**
 * Replace the active context-menu labels with the renderer's localized set. The
 * payload is untrusted, so every field is coerced to a string and falls back to
 * the English default when missing or not a string — the menu can never break on
 * a malformed push.
 */
export function setWebContextMenuLabels(raw: unknown): void {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof WebContextMenuLabels): string =>
    typeof src[key] === 'string' && src[key] !== '' ? (src[key] as string) : DEFAULT_LABELS[key];
  labels = {
    openLinkNewTab: pick('openLinkNewTab'),
    copyLinkAddress: pick('copyLinkAddress'),
    openImageNewTab: pick('openImageNewTab'),
    saveImage: pick('saveImage'),
    copyImage: pick('copyImage'),
    copyImageAddress: pick('copyImageAddress'),
    addToDictionary: pick('addToDictionary'),
    cut: pick('cut'),
    copy: pick('copy'),
    paste: pick('paste'),
    selectAll: pick('selectAll'),
    searchWeb: pick('searchWeb'),
    back: pick('back'),
    forward: pick('forward'),
    reload: pick('reload'),
    copyPageUrl: pick('copyPageUrl'),
    inspectElement: pick('inspectElement'),
  };
}

/**
 * Browser-style right-click menu for a web tab. The tab-opener is injected
 * (`openWebTab`) rather than imported so this module stays a leaf of the tab
 * lifecycle — ./tabs wires its own `createAndActivateTab` in when it builds the
 * menu, avoiding a context-menu ↔ tabs import cycle.
 */
type OpenWebTab = (url: string, opts?: { background?: boolean }) => void;

/**
 * Open a URL from a context-menu action the same way the window-open handler
 * does: http(s) opens in a new tab, anything else (mailto:, tel:, custom
 * schemes) is handed to the OS. Keeps menu navigation from funneling odd
 * schemes through the address-bar search heuristic. `background` keeps focus on
 * the current page (Chrome's "Open link in new tab" convention).
 */
function openUrlInTabOrExternal(
  url: string,
  openWebTab: OpenWebTab,
  background = false,
): void {
  if (/^https?:\/\//i.test(url)) {
    openWebTab(url, { background });
  } else {
    // mailto:/tel: → OS; file:/custom schemes are refused by openExternalUrl.
    void openExternalUrl(url);
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
        label: labels.openLinkNewTab,
        // Background tab — you keep reading the current page (Chrome convention).
        click: () => openUrlInTabOrExternal(linkURL, openWebTab, true),
      },
      { label: labels.copyLinkAddress, click: () => clipboard.writeText(linkURL) },
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
        label: labels.openImageNewTab,
        click: () => openWebTab(srcURL, { background: true }),
      });
    }
    items.push(
      { label: labels.saveImage, click: () => wc.downloadURL(srcURL) },
      { label: labels.copyImage, click: () => wc.copyImageAt(params.x, params.y) },
      { label: labels.copyImageAddress, click: () => clipboard.writeText(srcURL) },
      sep,
    );
  }

  if (params.isEditable) {
    // Spellcheck: when Chromium flagged a misspelling, offer its suggestions
    // (replace in place) then add-to-dictionary, ahead of the edit verbs.
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        items.push({
          label: suggestion,
          click: () => wc.replaceMisspelling(suggestion),
        });
      }
      items.push(
        {
          label: labels.addToDictionary,
          click: () =>
            wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        sep,
      );
    }
    items.push(
      { label: labels.cut, role: 'cut', enabled: params.editFlags.canCut },
      { label: labels.copy, role: 'copy', enabled: params.editFlags.canCopy },
      { label: labels.paste, role: 'paste', enabled: params.editFlags.canPaste },
      sep,
      { label: labels.selectAll, role: 'selectAll' },
    );
    return Menu.buildFromTemplate(items);
  }

  if (params.selectionText.trim()) {
    const q = params.selectionText.trim();
    const shortQ = q.length > 40 ? q.slice(0, 40) + '…' : q;
    items.push(
      { label: labels.copy, role: 'copy' },
      {
        label: labels.searchWeb.replace('{q}', shortQ),
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
    { label: labels.back, enabled: nh.canGoBack(), click: () => nh.goBack() },
    { label: labels.forward, enabled: nh.canGoForward(), click: () => nh.goForward() },
    { label: labels.reload, click: () => wc.reload() },
    sep,
    { label: labels.copyPageUrl, click: () => clipboard.writeText(wc.getURL()) },
    { label: labels.selectAll, role: 'selectAll' },
    sep,
    {
      label: labels.inspectElement,
      click: () => {
        // The DevTools dock lives in the renderer; ask it to open and select the
        // node under the cursor (CDP DOM.getNodeForLocation). params.x/y are in
        // the page's viewport CSS pixels, which is what getNodeForLocation wants.
        const h = getHost();
        if (h && !h.isDestroyed()) {
          h.webContents.send('devtools:inspect-at', {
            tabId: rec.id,
            x: params.x,
            y: params.y,
          });
        }
      },
    },
  );

  return Menu.buildFromTemplate(items);
}
