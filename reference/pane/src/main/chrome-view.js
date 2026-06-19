'use strict';
const path = require('node:path');
const { WebContentsView } = require('electron');

/**
 * The toolbar surface — a WebContentsView hosting the HTML/CSS/JS chrome.
 * Transparent background so Mica can show through (DESIGN §1/§6).
 */
class ChromeView {
  constructor() {
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // The chrome is fully-trusted local UI. Disabling the sandbox lets the
        // preload `require('../shared/channels')`; a sandboxed preload can only
        // require Electron/Node built-ins. The page view stays sandboxed.
        sandbox: false,
      },
    });
    this.view.setBackgroundColor('#00000000');
    this.view.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  get webContents() { return this.view.webContents; }

  /** Send an event down to the toolbar renderer. */
  send(channel, payload) {
    const wc = this.webContents;
    if (!wc.isDestroyed()) wc.send(channel, payload);
  }
}

module.exports = ChromeView;
