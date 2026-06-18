'use strict';
// pane://history — chronological visit list (grouped by day), search, per-row delete, clear.
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const searchEl = document.getElementById('search');
const DEL_SVG = window.PaneIcons.close;

function dayLabel(time) {
  const d = new Date(time);
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'long', day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}
const timeLabel = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const displayUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, '');

async function render() {
  const items = await window.paneInternal.history.list({ q: searchEl.value, limit: 1000 });
  listEl.replaceChildren();
  emptyEl.hidden = items.length > 0;

  let curDay = '';
  for (const it of items) {
    const day = dayLabel(it.time);
    if (day !== curDay) {
      curDay = day;
      const h = document.createElement('div');
      h.className = 'day';
      h.textContent = day;
      listEl.append(h);
    }

    const row = document.createElement('div');
    row.className = 'row';
    row.title = it.url;

    const time = document.createElement('span'); time.className = 'time'; time.textContent = timeLabel(it.time);
    const title = document.createElement('span'); title.className = 'title'; title.textContent = it.title || displayUrl(it.url);
    const url = document.createElement('span'); url.className = 'url'; url.textContent = displayUrl(it.url);
    const del = document.createElement('button'); del.className = 'del'; del.setAttribute('aria-label', 'Remove'); del.innerHTML = DEL_SVG;

    row.append(time, title, url, del);
    row.addEventListener('click', (e) => { if (!e.target.closest('.del')) window.paneInternal.navigate(it.url); });
    del.addEventListener('click', async (e) => { e.stopPropagation(); await window.paneInternal.history.remove(it.url, it.time); render(); });
    listEl.append(row);
  }
}

let t;
searchEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 120); });
document.getElementById('clear').addEventListener('click', async () => { await window.paneInternal.history.clear(); render(); });
render();
