'use strict';
const path = require('node:path');
const { WebContentsView } = require('electron');
const CH = require('../shared/channels');

/**
 * The devtools dock splitter — a thin draggable WebContentsView between the page and the
 * docked devtools. There is no single DOM surface spanning the seam between two native views,
 * so the handle is its own view. It reports the pointer's SCREEN position during a drag; the
 * window turns that into an exact dock size (immune to the splitter view itself moving
 * mid-drag). Orientation ('col' for a right dock, 'row' for a bottom dock) only swaps the
 * resize cursor.
 */
class SplitterView {
  constructor() {
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'splitter.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // lets the preload require ../shared/channels (same as the chrome view)
      },
    });
    this.view.setBackgroundColor('#00000000');
    this._orientation = 'col';
    this.webContents.loadFile(path.join(__dirname, 'splitter.html'));
    this.webContents.once('did-finish-load', () => this._send());
  }

  get webContents() { return this.view.webContents; }

  setOrientation(o) { if (o !== this._orientation) { this._orientation = o; this._send(); } }

  _send() { const wc = this.webContents; if (!wc.isDestroyed()) wc.send(CH.SPLITTER_ORIENTATION, this._orientation); }
}

module.exports = SplitterView;
