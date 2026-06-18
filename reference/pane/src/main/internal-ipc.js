'use strict';
// IPC handlers for the internal pages (window.paneInternal). Every handler re-verifies the
// sender is a pane:// page — the preload guard is convenience; this is the real boundary.
const { ipcMain } = require('electron');
const history = require('./history');
const settings = require('./settings');
const bookmarks = require('./bookmarks');
const downloads = require('./downloads');
const session = require('./session');

const fromInternal = (event) => {
  try { return new URL(event.senderFrame.url).protocol === 'pane:'; } catch { return false; }
};

function registerInternalIpc(resolveWindow) {
  // Route to the *sender's* window (the page issuing the command), not a single "current" one —
  // the multi-window / canvas groundwork (DESIGN §11). With one window this resolves to it.
  const active = (e) => { const w = resolveWindow(e.sender); return w && w.tabs ? w.tabs.active : null; };

  ipcMain.handle('pane-internal:navigate', (e, url) => {
    if (!fromInternal(e)) return;
    const p = active(e);
    if (p) p.navigate(url);
  });

  ipcMain.handle('pane-internal:history-list', (e, opts) => (fromInternal(e) ? history.list(opts) : []));
  ipcMain.handle('pane-internal:history-remove', (e, url, time) => { if (fromInternal(e)) history.remove(url, time); });
  ipcMain.handle('pane-internal:history-clear', (e) => { if (fromInternal(e)) history.clear(); });

  ipcMain.handle('pane-internal:settings-get', (e) => (fromInternal(e) ? settings.getAll() : {}));
  ipcMain.handle('pane-internal:settings-set', (e, key, value) => {
    if (!fromInternal(e)) return;
    settings.set(key, value);
    // Privacy: turning off session restore drops the stored snapshot (mirrors the toolbar path in ipc.js).
    if (key === 'restoreSession' && !value) session.clear();
  });

  ipcMain.handle('pane-internal:bookmarks-list', (e, opts) => (fromInternal(e) ? bookmarks.list(opts) : []));
  ipcMain.handle('pane-internal:bookmarks-remove', (e, url) => { if (fromInternal(e)) bookmarks.remove(url); });

  ipcMain.handle('pane-internal:downloads-list', (e) => (fromInternal(e) ? downloads.list() : []));
  ipcMain.handle('pane-internal:downloads-open', (e, id) => { if (fromInternal(e)) downloads.open(id); });
  ipcMain.handle('pane-internal:downloads-show', (e, id) => { if (fromInternal(e)) downloads.showInFolder(id); });
  ipcMain.handle('pane-internal:downloads-cancel', (e, id) => { if (fromInternal(e)) downloads.cancel(id); });
  ipcMain.handle('pane-internal:downloads-remove', (e, id) => { if (fromInternal(e)) downloads.removeEntry(id); });
  ipcMain.handle('pane-internal:downloads-clear', (e) => { if (fromInternal(e)) downloads.clearCompleted(); });

  // "Proceed anyway" from the cert error page: trust this host for the active tab, then it reloads.
  ipcMain.handle('pane-internal:cert-allow', (e, host) => { if (fromInternal(e)) { const p = active(e); if (p) p.allowCert(host); } });
}

module.exports = { registerInternalIpc, fromInternal };
