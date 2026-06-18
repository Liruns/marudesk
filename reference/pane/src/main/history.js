'use strict';
// Visited-page history as a visit LOG (per-visit timestamps) → powers both the omnibox
// autocomplete (aggregated) and the pane://history page (chronological). history.json.
const { readJSON, writeJSON } = require('./store');

const FILE = 'history.json';
const MAX = 10000;
let log = null; // [{ url, title, time }]
let saveTimer = null;

function load() {
  if (!log) { const d = readJSON(FILE, []); log = Array.isArray(d) ? d : []; }
  return log;
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => writeJSON(FILE, log), 1000); }
/** Force the debounced save now — call on app quit so the last ~1s of visits/titles isn't lost. */
function flush() { clearTimeout(saveTimer); if (log) writeJSON(FILE, log); }

function record(url) {
  if (!url || !/^https?:\/\//i.test(url)) return; // only real web pages
  load();
  log.push({ url, title: '', time: Date.now() });
  if (log.length > MAX) log = log.slice(log.length - MAX);
  scheduleSave();
}

function updateTitle(url, title) {
  if (!url || !title) return;
  load();
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].url === url) { log[i].title = title; break; } // the visit just recorded
  }
  scheduleSave();
}

/** Aggregate the log → rank by match + frequency + recency, for omnibox autocomplete. */
function query(input, limit = 5) {
  const q = (input || '').trim().toLowerCase();
  if (!q) return [];
  load();
  const now = Date.now();
  const agg = new Map();
  for (const e of log) {
    let a = agg.get(e.url);
    if (!a) { a = { url: e.url, title: e.title, visits: 0, last: 0 }; agg.set(e.url, a); }
    a.visits++;
    if (e.time >= a.last) { a.last = e.time; if (e.title) a.title = e.title; }
  }
  const out = [];
  for (const a of agg.values()) {
    const url = a.url.toLowerCase();
    const stripped = url.replace(/^https?:\/\/(www\.)?/, '');
    if (!url.includes(q) && !(a.title || '').toLowerCase().includes(q)) continue;
    const recency = Math.max(0, 30 - (now - a.last) / 86400000) / 30;
    const prefix = stripped.startsWith(q) ? 3 : 0;
    out.push({ url: a.url, title: a.title, score: a.visits + recency * 3 + prefix });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, limit).map(({ url, title }) => ({ url, title }));
}

/** Reverse-chronological visit list (optionally filtered) for the history page. */
function list({ q = '', limit = 500 } = {}) {
  load();
  const needle = (q || '').trim().toLowerCase();
  const items = [];
  for (let i = log.length - 1; i >= 0 && items.length < limit; i--) {
    const e = log[i];
    if (needle && !e.url.toLowerCase().includes(needle) && !(e.title || '').toLowerCase().includes(needle)) continue;
    items.push({ url: e.url, title: e.title, time: e.time });
  }
  return items;
}

function remove(url, time) {
  load();
  const i = log.findIndex((e) => e.url === url && e.time === time);
  if (i !== -1) { log.splice(i, 1); scheduleSave(); }
}

function clear() { log = []; writeJSON(FILE, log); }

module.exports = { record, updateTitle, query, list, remove, clear, flush };
