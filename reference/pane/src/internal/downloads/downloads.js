'use strict';
// pane://downloads — live download list. Active items stream progress via onChanged;
// completed items offer open / show-in-folder; any item can be removed from the list.
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const clearBtn = document.getElementById('clear');

const FILE_SVG = window.PaneIcons.file;
const X_SVG = window.PaneIcons.close;

const D = window.paneInternal.downloads;

function host(u) { try { return new URL(u).host; } catch { return u; } }
function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
function subText(d) {
  const h = host(d.url);
  if (d.state === 'progressing') {
    const of = d.totalBytes ? ` of ${fmtBytes(d.totalBytes)}` : '';
    return `${h} · ${fmtBytes(d.receivedBytes)}${of}${d.paused ? ' · Paused' : ''}`;
  }
  if (d.state === 'completed') return `${h} · ${fmtBytes(d.receivedBytes || d.totalBytes)}`;
  if (d.state === 'cancelled') return `${h} · Cancelled`;
  return `${h} · Failed`;
}

function act(label, fn) {
  const b = document.createElement('button');
  b.className = 'act';
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}
function delBtn(fn) {
  const b = document.createElement('button');
  b.className = 'act del';
  b.setAttribute('aria-label', 'Remove from list');
  b.innerHTML = X_SVG;
  b.addEventListener('click', fn);
  return b;
}

async function render() {
  const items = await D.list();
  listEl.replaceChildren();
  emptyEl.hidden = items.length > 0;
  clearBtn.style.visibility = items.some((d) => d.state !== 'progressing') ? 'visible' : 'hidden';

  for (const d of items) {
    const row = document.createElement('div');
    row.className = 'row' + (d.state === 'cancelled' || d.state === 'interrupted' ? ' gone' : '');
    row.title = d.savePath || d.url;

    const icon = document.createElement('div');
    icon.className = 'ficon';
    icon.innerHTML = FILE_SVG;

    const mid = document.createElement('div');
    mid.className = 'mid';
    const name = document.createElement('div');
    name.className = 'name' + (d.state === 'completed' ? ' link' : '');
    name.textContent = d.filename;
    if (d.state === 'completed') {
      // Keyboard-accessible open affordance (DESIGN §6): focusable, Enter/Space activate.
      name.setAttribute('role', 'button');
      name.tabIndex = 0;
      name.setAttribute('aria-label', `Open ${d.filename}`);
      const openFile = () => D.open(d.id);
      name.addEventListener('click', openFile);
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(); } });
    }
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = subText(d);
    mid.append(name, sub);

    if (d.state === 'progressing') {
      const bar = document.createElement('div');
      bar.className = 'bar' + (d.totalBytes ? '' : ' indet');
      const fill = document.createElement('div');
      fill.className = 'fill';
      if (d.totalBytes) fill.style.width = `${Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100))}%`;
      bar.append(fill);
      mid.append(bar);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (d.state === 'progressing') {
      actions.append(act('Cancel', () => D.cancel(d.id)));
    } else {
      if (d.state === 'completed') actions.append(act('Show in folder', () => D.showInFolder(d.id)));
      actions.append(delBtn(() => D.remove(d.id)));
    }

    row.append(icon, mid, actions);
    listEl.append(row);
  }
}

clearBtn.addEventListener('click', () => D.clear());
D.onChanged(() => render());
render();
