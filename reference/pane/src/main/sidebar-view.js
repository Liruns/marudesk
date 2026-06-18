'use strict';
const path = require('node:path');
const { WebContentsView } = require('electron');

/**
 * The vertical-tabs rail — a WebContentsView hosting the left-rail tab list (DESIGN §11 Arc/Zen
 * lineage). A sibling of ChromeView: same privileged preload (`window.pane`), transparent
 * background so the rail's own surface paints the chrome. Lives left of the page, tiled by
 * PaneWindow.layout() via the Sidebar controller (mirrors how the devtools dock is tiled).
 */
class SidebarView {
  constructor(onReady) {
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // lets the preload require ../shared/channels (same as the chrome view)
      },
    });
    this.view.setBackgroundColor('#00000000');
    this.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'sidebar.html'));
    if (onReady) this.webContents.once('did-finish-load', onReady);
  }

  get webContents() { return this.view.webContents; }

  /** Send an event down to the rail renderer. */
  send(channel, payload) {
    const wc = this.webContents;
    if (!wc.isDestroyed()) wc.send(channel, payload);
  }
}

module.exports = SidebarView;
