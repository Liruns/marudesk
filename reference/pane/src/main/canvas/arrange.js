'use strict';
const { CANVAS } = require('../../shared/config');

/**
 * Auto-placement for new canvas panes (CANVAS.md) — pure geometry, unit-tested.
 *
 * A fresh pane that has no world rect yet is dropped into the next free slot of a simple grid so
 * panes don't all stack on the origin. The user can drag them anywhere afterward; this only seeds
 * the initial position. Kept side-effect-free so it's testable without Electron.
 */
const COLUMNS = 3; // grid width before wrapping to a new row

/** The world rect for the pane at grid `index` (0-based), using CANVAS defaults unless overridden. */
function slotRect(index, opts = {}) {
  const width = opts.width ?? CANVAS.DEFAULT_PANE.width;
  const height = opts.height ?? CANVAS.DEFAULT_PANE.height;
  const gap = opts.gap ?? CANVAS.PANE_GAP;
  const columns = opts.columns ?? COLUMNS;
  const col = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: col * (width + gap),
    y: row * (height + gap),
    width,
    height,
  };
}

module.exports = { slotRect, COLUMNS };
