// Command palette (Ctrl+K) — a modal over the whole window (DESIGN §11, the Arc/Zen "quiet,
// personal" lineage). One box to switch between open tabs, search history, and run chrome actions.
// Like the other chrome overlays it grows the chrome view — here to the FULL window height (main
// supplies it), since the chrome otherwise only spans the toolbar — so the scrim + panel paint over
// the page; the chrome is transparent so the dimmed page shows through. Every untrusted string
// (tab titles/URLs, history) is written via textContent, never innerHTML, into this privileged doc.
import { on } from '../lib/dom.js';
import { openOverlay, closeOverlay } from '../lib/overlay.js';
import { ICONS } from '../lib/icons.js';

// Same guard as the tab strip — only real web favicons reach the privileged chrome document.
const SAFE_FAVICON = /^(?:https?|data):/i;
const display = (u) => (u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

let root, panel, input, listEl;
let rows = [];     // flat list of selectable item data, in display order
let rowEls = [];   // their DOM rows (parallel to `rows`)
let sel = -1;
let reqId = 0;     // stale-guard for async history queries
let lastW = 0;     // last window width — distinguishes a real resize from our own chrome-grow
let tabsState = { tabs: [], activeId: null, canReopen: false };
let histCache = { q: null, hist: null }; // last resolved history for the current query — lets a tab-driven re-render reuse it instead of re-querying/flickering

export function initCommandPalette() {
  root = document.createElement('div');
  root.id = 'cmdk';
  root.hidden = true;
  root.innerHTML =
    '<div class="cp-panel" role="dialog" aria-modal="true" aria-label="Command palette">' +
      '<div class="cp-search">' +
        `<span class="cp-search-icon" aria-hidden="true">${ICONS.search}</span>` +
        '<input id="cp-input" type="text" spellcheck="false" autocomplete="off" autocapitalize="off"' +
        ' role="combobox" aria-autocomplete="list" aria-controls="cp-list" aria-expanded="true"' +
        ' placeholder="Search tabs, history, and actions" />' +
      '</div>' +
      '<div class="cp-list" id="cp-list" role="listbox" aria-label="Results"></div>' +
    '</div>';
  document.body.append(root);
  panel = root.querySelector('.cp-panel');
  input = root.querySelector('#cp-input');
  listEl = root.querySelector('#cp-list');

  on(input, 'input', () => render(input.value));
  on(input, 'keydown', onKey);
  on(root, 'mousedown', (e) => { if (!e.target.closest('.cp-panel')) close(); }); // scrim click dismisses
  // Only a real window resize (width change) dismisses. Growing the chrome to host the palette fires
  // a height-only resize in this same document — guard on width so we don't self-close on open.
  lastW = window.innerWidth;
  on(window, 'resize', () => {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    if (!root.hidden) close();
  });

  // Keep the tab list fresh; re-render if the palette is open when tabs change. A tab push (e.g. a
  // background tab finishing load) must refresh titles/favicons WITHOUT yanking the user's keyboard
  // selection to the top — keepSel preserves it by identity so Enter never fires the wrong row.
  window.pane.onTabs((s) => { tabsState = s; if (!root.hidden) render(input.value, { keepSel: true }); });
  window.pane.onOpenPalette((d) => open(d && d.height));
}

function open(fullHeight) {
  if (!root.hidden) { input.focus(); input.select(); return; }
  input.value = '';
  root.hidden = false;
  // Replay the entrance each open — toggling [hidden] alone won't restart a CSS animation, so the
  // rise would otherwise only ever play on the session's first Ctrl+K (DESIGN §15).
  panel.classList.remove('rise');
  void panel.offsetWidth; // force reflow so re-adding the class restarts the animation
  panel.classList.add('rise');
  render('');
  input.focus();
  // Grow the chrome to cover the whole window so the scrim dims the page (main passes the content
  // height; fall back to the chrome doc's own height if it's somehow missing).
  openOverlay(close, Math.ceil(fullHeight || document.documentElement.getBoundingClientRect().height));
}

function close() {
  if (root.hidden) return;
  root.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  rows = [];
  rowEls = [];
  sel = -1;
  closeOverlay(close);
}

function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1); } // trap focus in the box
  else if (e.key === 'Enter') { e.preventDefault(); if (sel >= 0) activate(sel); }
  else if (e.key === 'Escape') { e.preventDefault(); close(); }
}

/* ── Sources ─────────────────────────────────────────────────────────────────
   Static chrome actions, the open tabs, then (only when there's a query) history. Each item carries
   a `run` callback; activating closes the palette first, then runs it (mirrors suggestions.commit). */
function actionItems(q) {
  const all = [
    { label: 'New tab',           hint: 'Ctrl+T',       icon: ICONS.plus,     run: () => window.pane.newTab() },
    { label: 'Reopen closed tab', hint: 'Ctrl+Shift+T', icon: ICONS.reopen,   run: () => window.pane.reopenClosedTab(), enabled: tabsState.canReopen },
    { label: 'Reload page',       hint: 'Ctrl+R',       icon: ICONS.reload,   run: () => window.pane.reload() },
    { label: 'Toggle DevTools',   hint: 'Ctrl+Shift+I', icon: ICONS.code,     run: () => window.pane.toggleDevTools() },
    { label: 'Bookmarks',         hint: '',             icon: ICONS.bookmark, run: () => window.pane.navigate('pane://bookmarks/') },
    { label: 'History',           hint: 'Ctrl+H',       icon: ICONS.history,  run: () => window.pane.navigate('pane://history/') },
    { label: 'Downloads',         hint: 'Ctrl+J',       icon: ICONS.download, run: () => window.pane.navigate('pane://downloads/') },
    { label: 'Settings',          hint: 'Ctrl+,',       icon: ICONS.settings, run: () => window.pane.navigate('pane://settings/') },
  ];
  return all
    .filter((a) => a.enabled !== false)
    .filter((a) => !q || a.label.toLowerCase().includes(q))
    .map((a) => ({ kind: 'action', label: a.label, hint: a.hint, icon: a.icon, run: a.run, query: q }));
}

function tabItems(q) {
  return tabsState.tabs
    .filter((t) => !q || ((t.title || '') + ' ' + (t.url || '')).toLowerCase().includes(q))
    .map((t) => ({
      kind: 'tab',
      id: t.id, // stable key so a re-render can re-select the same tab (titles can collide)
      label: t.title || 'New Tab',
      sub: display(t.url),
      favicon: t.favicon,
      active: t.id === tabsState.activeId,
      run: () => window.pane.activateTab(t.id),
      query: q,
    }));
}

function historyItems(hist, q) {
  return (hist || []).map((h) => ({
    kind: 'history',
    label: h.title || display(h.url),
    sub: display(h.url),
    icon: ICONS.history,
    run: () => window.pane.navigate(h.url),
    query: q,
  }));
}

// Stable identity for a row so a re-render (a tab push) can re-select the same item the user was on,
// instead of snapping to the top. Tabs key by id (titles collide), history by URL, actions by label.
function keyOf(it) {
  if (!it) return null;
  if (it.kind === 'tab') return 'tab:' + it.id;
  if (it.kind === 'history') return 'hist:' + it.sub;
  return 'action:' + it.label;
}

function render(raw, opts) {
  const keepSel = !!(opts && opts.keepSel); // tab-driven re-render preserves selection; typing resets to the top
  const q = raw.trim().toLowerCase();
  const my = ++reqId;
  const prevKey = keepSel ? keyOf(rows[sel]) : null; // what the user was on, to restore by identity
  listEl.replaceChildren();
  rows = [];
  rowEls = [];
  sel = -1;

  // Restore the prior selection by identity (tab push), else select the first row (typing/open).
  const reselect = () => {
    if (prevKey) {
      const i = rows.findIndex((it) => keyOf(it) === prevKey);
      if (i >= 0) { highlight(i); return; }
    }
    selectFirst();
  };

  appendSection('Actions', actionItems(q));
  appendSection('Tabs', tabItems(q));

  if (q) {
    // Same query as the last paint (a tab push re-renders with the query unchanged) → reuse the
    // cached history rather than re-querying the DB and flickering the History section out and back.
    if (histCache.q === q && histCache.hist) {
      appendSection('History', historyItems(histCache.hist, q));
      reselect();
      updateEmpty(false);
      return;
    }
    // New query: history needs a DB round-trip — keep the first paint instant, then splice it in.
    // Guard against a newer keystroke (reqId) or a close having landed first.
    window.pane.queryHistory(raw.trim())
      .then((hist) => {
        if (my !== reqId || root.hidden) return;
        histCache = { q, hist };
        const e = listEl.querySelector('.cp-empty'); if (e) e.remove();
        appendSection('History', historyItems(hist, q));
        reselect();
        updateEmpty(false);
      })
      .catch(() => { if (my === reqId && !root.hidden) updateEmpty(false); });
  } else {
    histCache = { q: null, hist: null }; // empty query — drop the cache so the next query re-reads
  }

  reselect();
  updateEmpty(!!q); // a pending history query suppresses the "No results" line until it lands
}

function appendSection(title, items) {
  if (!items.length) return;
  const head = document.createElement('div');
  head.className = 'cp-head';
  head.textContent = title;
  listEl.append(head);
  for (const it of items) {
    const el = rowEl(it, rows.length);
    rows.push(it);
    rowEls.push(el);
    listEl.append(el);
  }
}

function rowEl(it, i) {
  const row = document.createElement('div');
  row.className = 'cp-row';
  row.setAttribute('role', 'option');
  row.id = `cp-row-${i}`;

  const icon = document.createElement('span');
  icon.className = 'cp-icon';
  if (it.kind === 'tab') {
    // Untrusted favicon URL — same scheme guard as the tab strip, with a globe fallback.
    if (it.favicon && SAFE_FAVICON.test(it.favicon)) {
      const img = document.createElement('img');
      img.src = it.favicon;
      img.onerror = () => { icon.innerHTML = ICONS.globe; };
      icon.append(img);
    } else {
      icon.innerHTML = ICONS.globe;
    }
  } else {
    icon.innerHTML = it.icon || ICONS.arrowRight;
  }

  const body = document.createElement('span');
  body.className = 'cp-body';
  const label = document.createElement('span');
  label.className = 'cp-label';
  fillLabel(label, it.label, it.query); // matched substring → weight 590 (DESIGN §3/§4)
  body.append(label);
  if (it.sub) {
    const sub = document.createElement('span');
    sub.className = 'cp-sub';
    sub.textContent = it.sub; // untrusted URL → text node
    body.append(sub);
  }

  row.append(icon, body);

  if (it.hint) {
    const k = document.createElement('span');
    k.className = 'cp-key';
    k.textContent = it.hint;
    row.append(k);
  } else if (it.active) {
    const tag = document.createElement('span');
    tag.className = 'cp-tag';
    tag.textContent = 'Active';
    row.append(tag);
  }

  on(row, 'mousemove', () => highlight(i));
  on(row, 'mousedown', (e) => { e.preventDefault(); activate(i); });
  return row;
}

function move(dir) {
  if (!rows.length) return;
  // From no selection: Down → first, Up → last (conventional combobox behavior).
  const next = sel < 0 ? (dir > 0 ? 0 : rows.length - 1) : (sel + dir + rows.length) % rows.length;
  highlight(next);
}

function selectFirst() {
  if (sel < 0 && rows.length) highlight(0);
}

function highlight(i) {
  sel = i;
  rowEls.forEach((el, j) => {
    const isSel = j === i;
    el.classList.toggle('selected', isSel);
    el.setAttribute('aria-selected', isSel ? 'true' : 'false');
  });
  if (i >= 0 && rowEls[i]) {
    input.setAttribute('aria-activedescendant', rowEls[i].id);
    rowEls[i].scrollIntoView({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

function activate(i) {
  const it = rows[i];
  if (!it) return;
  close();    // shrink the chrome back before the action runs (matches suggestions.commit ordering)
  it.run();
}

function updateEmpty(pending) {
  // Keep the combobox's advertised expanded state honest for screen readers (it reflects whether
  // there are options to navigate, not merely whether the box is visible).
  input.setAttribute('aria-expanded', rows.length ? 'true' : 'false');
  const existing = listEl.querySelector('.cp-empty');
  if (rows.length || pending) { if (existing) existing.remove(); return; }
  if (!existing) {
    const empty = document.createElement('div');
    empty.className = 'cp-empty';
    empty.textContent = 'No results';
    listEl.append(empty);
  }
}

// Emphasize the matched query substring by weight (DESIGN §3/§4), built from text nodes so a
// history title/URL can never inject markup into the privileged chrome.
function fillLabel(el, label, q) {
  el.textContent = '';
  const query = (q || '').trim();
  const i = query ? label.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (i === -1) { el.textContent = label; return; }
  const m = document.createElement('span');
  m.className = 'cp-match';
  m.textContent = label.slice(i, i + query.length);
  el.append(document.createTextNode(label.slice(0, i)), m, document.createTextNode(label.slice(i + query.length)));
}
