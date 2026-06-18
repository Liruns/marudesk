'use strict';
// Bookmarks — a flat, newest-first list persisted to bookmarks.json. Toggled with Ctrl+D
// on the active page, managed on pane://bookmarks.
const { readJSON, writeJSON } = require('./store');

const FILE = 'bookmarks.json';
let items = null;

function load() { if (!items) { const d = readJSON(FILE, []); items = Array.isArray(d) ? d : []; } return items; }
function save() { writeJSON(FILE, items); }

function has(url) { load(); return items.some((b) => b.url === url); }

function add(url, title) {
  load();
  if (items.some((b) => b.url === url)) return;
  items.unshift({ url, title: title || url, time: Date.now() });
  save();
}

function remove(url) {
  load();
  const i = items.findIndex((b) => b.url === url);
  if (i !== -1) { items.splice(i, 1); save(); }
}

/** Toggle the page's bookmark. Returns true=added, false=removed, null=not bookmarkable. */
function toggle(url, title) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  if (has(url)) { remove(url); return false; }
  add(url, title);
  return true;
}

function list({ q = '' } = {}) {
  load();
  const needle = q.trim().toLowerCase();
  const r = needle
    ? items.filter((b) => b.url.toLowerCase().includes(needle) || (b.title || '').toLowerCase().includes(needle))
    : items;
  return r.map((b) => ({ ...b }));
}

module.exports = { has, add, remove, toggle, list };
