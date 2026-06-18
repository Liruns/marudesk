'use strict';
// Downloads — tracks every DownloadItem from the default session, auto-saves to the OS
// Downloads folder (no dialog), and feeds pane://downloads. Completed/cancelled items
// persist to downloads.json; in-flight items live in memory and stream progress to any
// open downloads page via the 'pane-internal:downloads-changed' push.
const { app, session, shell, webContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { readJSON, writeJSON } = require('./store');

const FILE = 'downloads.json';
const MAX = 200;
let done = null;              // persisted, newest-first: completed/cancelled/interrupted
const active = new Map();     // id → { item, meta }
let seq = 0;
let saveTimer = null;

function loadDone() { if (!done) { const d = readJSON(FILE, []); done = Array.isArray(d) ? d : []; } return done; }
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => writeJSON(FILE, done), 800); }
/** Flush a pending debounced save now — call on app quit so a just-finished download isn't lost. */
function flush() { clearTimeout(saveTimer); if (done) writeJSON(FILE, done); }

/** Avoid clobbering an existing file: name → name (1) → name (2) … */
function uniquePath(dir, name) {
  const safe = name || 'download';
  let p = path.join(dir, safe);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  for (let i = 1; i < 1000; i++) {
    p = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return p;
}

function init() {
  loadDone();
  seq = done.reduce((m, x) => Math.max(m, x.id || 0), 0); // keep ids unique across runs

  session.defaultSession.on('will-download', (_e, item) => {
    const id = ++seq;
    const savePath = uniquePath(app.getPath('downloads'), item.getFilename());
    item.setSavePath(savePath); // skip the save dialog

    const meta = {
      id,
      url: item.getURL(),
      filename: path.basename(savePath),
      savePath,
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'progressing',
      paused: false,
      startTime: Date.now(),
    };
    active.set(id, { item, meta });

    item.on('updated', (_ev, state) => {
      meta.receivedBytes = item.getReceivedBytes();
      meta.totalBytes = item.getTotalBytes();
      meta.paused = item.isPaused();
      meta.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      changedThrottled(); // many ticks/sec — coalesce so the page doesn't rebuild on every byte
    });
    item.once('done', (_ev, state) => {
      active.delete(id);
      if (meta.removed) { changed(); return; } // user removed it mid-flight — don't resurrect the row
      meta.receivedBytes = item.getReceivedBytes();
      meta.state = state; // 'completed' | 'cancelled' | 'interrupted'
      done.unshift(meta);
      if (done.length > MAX) done.length = MAX;
      scheduleSave();
      changed();
    });
    changed();
  });
}

/** Push a refresh signal to every open pane://downloads page. */
function changed() {
  for (const wc of webContents.getAllWebContents()) {
    try { if (wc.getURL().startsWith('pane://downloads')) wc.send('pane-internal:downloads-changed'); } catch { /* gone */ }
  }
}

// Leading-edge throttle for progress ticks: refresh now, then at most once per 250ms. The
// immediate 'done'/'will-download' pushes call changed() directly so final state is never delayed.
let changeTimer = null;
function changedThrottled() {
  if (changeTimer) return;
  changed();
  changeTimer = setTimeout(() => { changeTimer = null; }, 250);
}

function list() {
  loadDone();
  const live = [...active.values()].map((x) => ({ ...x.meta })).sort((a, b) => b.startTime - a.startTime);
  return [...live, ...done.map((m) => ({ ...m }))];
}

function byId(id) {
  const a = active.get(id);
  if (a) return a.meta;
  return loadDone().find((m) => m.id === id) || null;
}

function open(id) { const m = byId(id); if (m && m.state === 'completed') shell.openPath(m.savePath); }
function showInFolder(id) { const m = byId(id); if (m) shell.showItemInFolder(m.savePath); }
function cancel(id) { const a = active.get(id); if (a) a.item.cancel(); }

/** Remove from the list (cancels if in-flight). Does not delete the file on disk. */
function removeEntry(id) {
  const a = active.get(id);
  if (a) { a.meta.removed = true; try { a.item.cancel(); } catch { /* gone */ } active.delete(id); }
  loadDone();
  const i = done.findIndex((m) => m.id === id);
  if (i !== -1) { done.splice(i, 1); scheduleSave(); }
  changed();
}

function clearCompleted() { done = []; writeJSON(FILE, done); changed(); }

module.exports = { init, list, open, showInFolder, cancel, removeEntry, clearCompleted, flush };
