'use strict';

/**
 * Live PaneWindow registry — the infinite-canvas / multi-window groundwork (DESIGN §11).
 *
 * v0 runs exactly one window, and for a long time `index.js` held it in a single `current` ref.
 * That bakes a single-window assumption into every IPC route: a command is sent to "the" window
 * rather than the window that *sent* it. The canvas future (and any multi-window step before it)
 * needs each message routed to the **sender's** window — so the trust gate validates against the
 * right window and a second window's legit chrome isn't dropped (see PaneWindow.isTrustedChromeSender).
 *
 * Keeping the set of live windows here lets `ipc.js` / `internal-ipc.js` resolve per-sender today,
 * with no behavior change while there's one window (fromSender returns that one for its own views).
 */
const live = new Set();

/** Track a newly-created window. Returns it for chaining. */
function add(win) { live.add(win); return win; }

/** Drop a window once it's closed. */
function remove(win) { live.delete(win); }

/** All live windows (snapshot — safe to iterate while windows open/close). */
function all() { return [...live]; }

/** How many windows are live. */
function count() { return live.size; }

/**
 * Resolve the PaneWindow that owns `sender` (a chrome / sidebar / splitter / page webContents).
 * This is the per-sender routing the canvas future needs; with one window it returns that window
 * for any of its own views, and null for a stray sender (which the trust gate then drops).
 */
function fromSender(sender) {
  if (!sender) return null;
  for (const w of live) {
    if (!w.win.isDestroyed() && w.owns(sender)) return w;
  }
  return null;
}

/**
 * The focused window, falling back to any live one — for sender-less paths (app lifecycle like
 * before-quit session save). With one window this is just that window.
 */
function focused() {
  for (const w of live) if (!w.win.isDestroyed() && w.win.isFocused()) return w;
  for (const w of live) if (!w.win.isDestroyed()) return w;
  return null;
}

module.exports = { add, remove, all, count, fromSender, focused };
