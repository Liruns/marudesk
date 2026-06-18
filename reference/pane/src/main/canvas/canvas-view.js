'use strict';
const path = require('node:path');
const { WebContentsView } = require('electron');

/**
 * The infinite-canvas surface — a WebContentsView hosting the pane frames + gesture layer
 * (CANVAS.md). A sibling of SidebarView: same privileged preload (`window.pane`), transparent
 * background so the live page views (separate native views) show through ON TOP of it. The window
 * keeps this view BELOW the page views in z-order, so this renderer draws only chrome (title bars,
 * border rings) in the gaps and catches pan/zoom gestures where no page covers it.
 */
class CanvasView {
  constructor(onReady) {
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // lets the preload require ../shared/channels (same as the chrome/rail views)
      },
    });
    this.view.setBackgroundColor('#00000000'); // transparent — the window paints the canvas substrate
    this.webContents.loadFile(path.join(__dirname, '..', '..', 'renderer', 'canvas.html'));
    if (onReady) this.webContents.once('did-finish-load', onReady);
  }

  get webContents() { return this.view.webContents; }

  send(channel, payload) {
    const wc = this.webContents;
    if (!wc.isDestroyed()) wc.send(channel, payload);
  }
}

module.exports = CanvasView;
