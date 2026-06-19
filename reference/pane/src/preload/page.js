'use strict';
// Preload for the page view. Exposes window.paneInternal ONLY to our internal pages
// (pane:// origin) — never to remote web content. Main re-checks the sender's origin too.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'pane:') {
  contextBridge.exposeInMainWorld('paneInternal', {
    navigate: (url) => ipcRenderer.invoke('pane-internal:navigate', url),
    history: {
      list: (opts) => ipcRenderer.invoke('pane-internal:history-list', opts),
      remove: (url, time) => ipcRenderer.invoke('pane-internal:history-remove', url, time),
      clear: () => ipcRenderer.invoke('pane-internal:history-clear'),
    },
    settings: {
      get: () => ipcRenderer.invoke('pane-internal:settings-get'),
      set: (key, value) => ipcRenderer.invoke('pane-internal:settings-set', key, value),
    },
    bookmarks: {
      list: (opts) => ipcRenderer.invoke('pane-internal:bookmarks-list', opts),
      remove: (url) => ipcRenderer.invoke('pane-internal:bookmarks-remove', url),
    },
    downloads: {
      list: () => ipcRenderer.invoke('pane-internal:downloads-list'),
      open: (id) => ipcRenderer.invoke('pane-internal:downloads-open', id),
      showInFolder: (id) => ipcRenderer.invoke('pane-internal:downloads-show', id),
      cancel: (id) => ipcRenderer.invoke('pane-internal:downloads-cancel', id),
      remove: (id) => ipcRenderer.invoke('pane-internal:downloads-remove', id),
      clear: () => ipcRenderer.invoke('pane-internal:downloads-clear'),
      onChanged: (cb) => ipcRenderer.on('pane-internal:downloads-changed', () => cb()),
    },
    cert: {
      allow: (host) => ipcRenderer.invoke('pane-internal:cert-allow', host), // "Proceed anyway" from the error page
    },
  });
}
