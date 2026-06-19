'use strict';
// Pane — main-process entry. App lifecycle + window bootstrap.
const { app, BaseWindow } = require('electron');
const PaneWindow = require('./pane-window');
const windows = require('./windows');
const { registerIpc } = require('./ipc');
const { registerScheme, handle } = require('./protocol');
const { registerInternalIpc } = require('./internal-ipc');
const downloads = require('./downloads');
const settings = require('./settings');
const session = require('./session');
const history = require('./history');

registerScheme(); // must run before app 'ready'

function createWindow() {
  const restore = settings.get('restoreSession') ? session.load() : null;
  const w = windows.add(new PaneWindow(restore));
  w.win.on('closed', () => windows.remove(w)); // drop it from the registry once gone
  return w;
}

app.whenReady().then(() => {
  handle();                                  // serve pane://
  downloads.init();                          // attach to session will-download
  // IPC routes to the SENDER's window via the registry (windows.fromSender) — the multi-window /
  // canvas groundwork (DESIGN §11). With one window this resolves to that window.
  registerIpc((sender) => windows.fromSender(sender));         // window.pane (toolbar)
  registerInternalIpc((sender) => windows.fromSender(sender)); // window.paneInternal (internal pages)
  createWindow();
  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // v0 persists a single session. Save the focused (i.e. the one) window's snapshot; the
  // multi-window session story is an open question deferred to the canvas work (see CANVAS.md).
  const w = settings.get('restoreSession') ? windows.focused() : null;
  if (w && !w.win.isDestroyed()) session.saveNow(w.serialize());
  downloads.flush(); // persist any just-finished download still inside the save debounce
  history.flush();   // persist the last ~1s of visits/titles still inside the save debounce
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
