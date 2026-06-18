'use strict';
// Pane — devtools-splitter preload. A one-purpose bridge: report a drag (in screen coords) and
// receive the resize-cursor orientation. Exposed only to the local splitter.html helper view.
const { contextBridge, ipcRenderer } = require('electron');
const CH = require('../shared/channels');

contextBridge.exposeInMainWorld('paneSplitter', {
  drag: (x, y) => ipcRenderer.send(CH.SPLITTER_DRAG, x, y),
  end: () => ipcRenderer.send(CH.SPLITTER_DRAG_END),
  onOrientation: (cb) => ipcRenderer.on(CH.SPLITTER_ORIENTATION, (_e, o) => cb(o)),
});
