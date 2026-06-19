'use strict';
// pane://bookmarks — flat newest-first list, search, per-row delete. Added via Ctrl+D.
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const searchEl = document.getElementById('search');
const DEL_SVG = window.PaneIcons.close;

const displayUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, '');

async function render() {
  const items = await window.paneInternal.bookmarks.list({ q: searchEl.value });
  listEl.replaceChildren();
  emptyEl.hidden = items.length > 0;

  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'row';
    row.title = it.url;

    const title = document.createElement('span'); title.className = 'title'; title.textContent = it.title || displayUrl(it.url);
    const url = document.createElement('span'); url.className = 'url'; url.textContent = displayUrl(it.url);
    const del = document.createElement('button'); del.className = 'del'; del.setAttribute('aria-label', 'Remove'); del.innerHTML = DEL_SVG;

    row.append(title, url, del);
    row.addEventListener('click', (e) => { if (!e.target.closest('.del')) window.paneInternal.navigate(it.url); });
    del.addEventListener('click', async (e) => { e.stopPropagation(); await window.paneInternal.bookmarks.remove(it.url); render(); });
    listEl.append(row);
  }
}

let t;
searchEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 120); });
render();
