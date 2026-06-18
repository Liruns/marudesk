'use strict';
// In-page right-click menu — a native Electron Menu (replaces a would-be hand-rolled HTML menu).
// Because it is an OS menu it follows Win32 conventions (Title-Case verbs, native popup), not the
// HTML chrome grammar of DESIGN §4 — but the actions honor Pane's contracts: "Open in New Tab"
// makes an in-app background tab, "Save Image" reuses the auto-save downloads pipeline, "Inspect
// Element" routes through Pane's managed dockable devtools (never Chromium's own docked window).
const { Menu, BaseWindow, clipboard } = require('electron');

// Mirrors the renderer url-parser's SEARCH_BASE (DESIGN §10). Duplicated by necessity: url-parser.js
// is renderer ESM and can't be required from the CommonJS main process — keep the two in sync.
const SEARCH_BASE = 'https://www.google.com/search?q=';
const searchUrl = (q) => SEARCH_BASE + encodeURIComponent(q);

// A page-supplied URL (a link href / image src) is attacker-controlled, and "Open in New Tab"
// navigates a fresh tab via loadURL, which bypasses the will-navigate pane:// guard in page-view.js.
// So the in-app "Open in New Tab" affordance is offered ONLY for schemes that are safe to open from
// untrusted markup: http/https and blob (a live, opaque-origin object URL, e.g. a generated image).
// Deliberately excluded: pane:// / javascript: (privileged-surface / script injection), data: (a
// top-level spoofing vector Chromium blocks anyway), and file: (a local-filesystem bridge that must
// not be one click from a web page's link). Copy Address stays for any scheme (copying text is
// harmless) — only the navigating action is gated. Mirrors the web-content trust boundary main keeps.
const OPENABLE = /^(https?|blob):/i;

// Build a native-menu label from page text (a link, a selection). Collapse whitespace, cap the
// length so a long selection can't stretch the menu off-screen, and double every '&' so Win32
// renders it literally instead of swallowing it as a mnemonic underline.
function menuLabel(text, max = 48) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const clipped = t.length > max ? t.slice(0, max - 1) + '…' : t;
  // Win32 swallows a single '&' as a mnemonic underline, so double it to render literally. On
  // macOS/Linux the native menu shows '&' as-is — doubling there would print a spurious second '&'.
  return process.platform === 'win32' ? clipped.replace(/&/g, '&&') : clipped;
}

/**
 * Build the native-menu template for a context-menu event — pure (no Menu/popup), so the branch +
 * separator logic is unit-testable without an Electron runtime. Returns an array of Electron
 * MenuItem options assembled from what was clicked (link / image / editable / selection / plain
 * page), with Inspect Element always last. Most click handlers run inline on the webContents
 * (clipboard, edit, navigation, download); the two that need orchestration bubble up as PageView
 * events (PageView is an EventEmitter):
 *
 *   'open-tab'(url, { background })  → TabManager opens a tab right after this one
 *   'inspect'(x, y)                  → the window routes to DevtoolsDock (open devtools, then inspect)
 *
 * @param {object} params  the Electron context-menu params (linkURL, srcURL, editFlags, …).
 * @param {import('./page-view')} page  the PageView — supplies webContents + nav predicates + emit.
 * @returns {Array<object>} the Menu.buildFromTemplate template.
 */
function buildTemplate(params, page) {
  const wc = page.webContents;
  const t = [];
  // Add a separator only between non-empty sections — never leading, trailing-before-nothing, or doubled.
  const sep = () => { if (t.length && t[t.length - 1].type !== 'separator') t.push({ type: 'separator' }); };

  // Link — open in a background tab (you keep reading the current page) or copy the address.
  if (params.linkURL) {
    if (OPENABLE.test(params.linkURL)) {
      t.push({ label: 'Open Link in New Tab', click: () => page.emit('open-tab', params.linkURL, { background: true }) });
    }
    t.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
    sep();
  }

  // Image — open / save / copy. "Save Image" (not "…As"): downloads.js auto-saves to the OS
  // Downloads folder without a dialog, so there's no "As" to offer.
  if (params.mediaType === 'image' && params.hasImageContents && params.srcURL) {
    if (OPENABLE.test(params.srcURL)) {
      t.push({ label: 'Open Image in New Tab', click: () => page.emit('open-tab', params.srcURL, { background: true }) });
    }
    t.push({ label: 'Save Image', click: () => wc.downloadURL(params.srcURL) });
    t.push({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) });
    t.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) });
    sep();
  }

  if (params.isEditable) {
    // Spellcheck (when Chromium flagged a misspelling) — suggestions, then add-to-dictionary.
    if (params.misspelledWord) {
      for (const s of params.dictionarySuggestions || []) {
        t.push({ label: s, click: () => wc.replaceMisspelling(s) });
      }
      t.push({ label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      sep();
    }
    // Standard edit verbs, each gated by Chromium's editFlags so a disabled one greys out.
    const f = params.editFlags || {};
    t.push({ label: 'Cut', enabled: !!f.canCut, click: () => wc.cut() });
    t.push({ label: 'Copy', enabled: !!f.canCopy, click: () => wc.copy() });
    t.push({ label: 'Paste', enabled: !!f.canPaste, click: () => wc.paste() });
    t.push({ label: 'Select All', enabled: !!f.canSelectAll, click: () => wc.selectAll() });
    sep();
  } else if (params.selectionText && params.selectionText.trim()) {
    // Non-editable selection — copy it, or search for it (foreground tab, matching Chrome). DESIGN §10.
    const q = params.selectionText.trim();
    t.push({ label: 'Copy', click: () => wc.copy() });
    t.push({ label: `Search for “${menuLabel(q)}”`, click: () => page.emit('open-tab', searchUrl(q), { background: false }) });
    sep();
  } else if (!params.linkURL && params.mediaType === 'none') {
    // Plain page area (no link, no media, no selection) — navigation verbs, like Chrome.
    t.push({ label: 'Back', enabled: page.canGoBack(), click: () => page.back() });
    t.push({ label: 'Forward', enabled: page.canGoForward(), click: () => page.forward() });
    t.push({ label: 'Reload', click: () => page.reload() });
    sep();
  }

  // Always last — Pane's managed devtools (the same per-tab dockable host the toggle uses, DESIGN §4),
  // not Chromium's own. The coordinates are page-local, exactly what inspectElement expects.
  t.push({ label: 'Inspect Element', click: () => page.emit('inspect', params.x, params.y) });

  return t;
}

/**
 * Attach the contextual right-click menu to a tab's page: on every context-menu event, build the
 * template for what was clicked and pop a native menu.
 *
 * @param {import('./page-view')} page  the PageView whose webContents to attach to.
 */
function attachPageContextMenu(page) {
  const wc = page.webContents;
  wc.on('context-menu', (_event, params) => {
    if (wc.isDestroyed()) return;
    // Pop over the window the right-click just focused (a click focuses its owning window), so a
    // multi-window setup lands the menu on the correct one instead of Electron's last-focused default.
    const win = BaseWindow.getFocusedWindow();
    Menu.buildFromTemplate(buildTemplate(params, page)).popup(win ? { window: win } : undefined);
  });
}

module.exports = { attachPageContextMenu, buildTemplate, menuLabel };
