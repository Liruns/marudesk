// The tab strip: renders the tab list from main, routes clicks/drags/right-clicks back as
// tab actions. (Keyboard shortcuts — Ctrl+T/W/Tab, Ctrl+Shift+T — are handled in the main
// process via before-input-event so their preventDefault reliably stops focus traversal.)
import { $, on } from '../lib/dom.js';
import { ICONS } from '../lib/icons.js';
import { openOverlay, closeOverlay } from '../lib/overlay.js';
import { initMenuNav, focusFirstItem } from '../lib/menu-nav.js';

// Only let web favicons into the privileged chrome document (no file:/pane:/js: schemes).
const SAFE_FAVICON = /^(?:https?|data):/i;

let state = { tabs: [], activeId: null, canReopen: false };
let dragId = null;
let ctx; // the right-click context-menu panel

export function initTabs() {
  const list = $('#tabs');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', 'Tabs'); // parity with the rail's labelled tablist (a11y)
  on($('#newtab'), 'click', () => window.pane.newTab());
  window.pane.onTabs((s) => { state = s; if (dragId == null) render(list, s); });
  // Vertical-tabs mode (DESIGN §11): the left rail hosts the list, so hide the top strip's tabs.
  // The #tabstrip row itself stays (it reserves the WCO + window-drag region).
  window.pane.onLayout((s) => document.body.classList.toggle('vertical-tabs', !!s.verticalTabs));

  initDrag(list);
  initKeyboard(list);
  initContextMenu(list);
}

// Tablist keyboard: Arrow keys move focus between tabs (roving), Enter/Space activates.
// (Ctrl+Tab still cycles the active tab; that's handled in the main process.)
function initKeyboard(list) {
  on(list, 'keydown', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    const els = [...list.querySelectorAll('.tab')];
    const i = els.indexOf(el);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      els[(i + (e.key === 'ArrowRight' ? 1 : -1) + els.length) % els.length].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      window.pane.activateTab(Number(el.dataset.id));
    }
  });
}

function faviconEl(tab) {
  const fav = document.createElement('span');
  fav.className = 'favicon';
  if (tab.favicon && SAFE_FAVICON.test(tab.favicon)) {
    const img = document.createElement('img');
    img.src = tab.favicon;
    img.onerror = () => { fav.innerHTML = ICONS.globe; };
    fav.append(img);
  } else {
    fav.innerHTML = ICONS.globe;
  }
  return fav;
}

function render(list, s) {
  // Preserve keyboard focus across the rebuild (a background tab can update mid arrow-nav).
  const act = document.activeElement;
  const focusedId = act && act.classList && act.classList.contains('tab') ? Number(act.dataset.id) : null;

  list.replaceChildren();
  for (const t of s.tabs) {
    const isActive = t.id === s.activeId;
    const tab = document.createElement('div');
    tab.className = 'tab' + (isActive ? ' active' : '') + (t.loading ? ' loading' : '');
    tab.title = t.url || t.title || '';
    tab.draggable = true;
    tab.dataset.id = t.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.tabIndex = isActive ? 0 : -1; // roving: the active tab is the strip's single tab-stop

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title || 'New Tab';

    const close = document.createElement('button');
    close.className = 'close';
    close.setAttribute('aria-label', 'Close tab');
    close.tabIndex = -1; // keep the strip one tab-stop; close via Ctrl+W or click
    close.innerHTML = ICONS.close;

    tab.append(faviconEl(t), title, close);
    on(tab, 'click', () => window.pane.activateTab(t.id));
    on(close, 'click', (e) => { e.stopPropagation(); window.pane.closeTab(t.id); });
    list.append(tab);
  }

  // Restore focus only while the chrome itself holds focus — otherwise activating a tab
  // (which focuses the page) would immediately steal focus back to the strip.
  if (focusedId != null && document.hasFocus()) {
    const refocus = [...list.children].find((el) => Number(el.dataset.id) === focusedId);
    if (refocus) refocus.focus();
  }
}

/* ── Drag to reorder ────────────────────────────────────────────────────────
   Delegated on the list so handlers survive every re-render. `pos` is the slot
   in the *current* list before which to drop; main reconciles it. */
function initDrag(list) {
  on(list, 'dragstart', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    dragId = Number(el.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  on(list, 'dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    mark(list, e);
  });
  on(list, 'drop', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    window.pane.moveTab(dragId, dropPos(list, e));
    endDrag(list);
  });
  on(list, 'dragend', () => endDrag(list));
}

function dropPos(list, e) {
  const els = [...list.querySelectorAll('.tab')];
  const target = e.target.closest('.tab');
  if (!target) return els.length; // dropped past the last tab → append
  const j = els.indexOf(target);
  const r = target.getBoundingClientRect();
  return e.clientX > r.left + r.width / 2 ? j + 1 : j;
}

function mark(list, e) {
  clearDropMarks(list);
  const target = e.target.closest('.tab');
  if (!target || Number(target.dataset.id) === dragId) return; // don't mark the dragged tab itself
  const r = target.getBoundingClientRect();
  target.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
}

// Clear only the drop-slot indicators — the dragged tab keeps `.dragging` until the drag ends.
function clearDropMarks(list) {
  for (const el of list.querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

function endDrag(list) {
  clearDropMarks(list);
  const dragged = list.querySelector('.dragging');
  if (dragged) dragged.classList.remove('dragging');
  dragId = null;
}

/* ── Right-click context menu ────────────────────────────────────────────── */
function initContextMenu(list) {
  ctx = document.createElement('div');
  ctx.className = 'ctx-menu';
  ctx.setAttribute('role', 'menu');
  ctx.hidden = true;
  document.body.append(ctx);
  initMenuNav(ctx);

  on(list, 'contextmenu', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    e.preventDefault();
    openContextMenu(Number(el.dataset.id), e.clientX, e.clientY);
  });
  on(window, 'mousedown', (e) => { if (!ctx.hidden && !e.target.closest('.ctx-menu')) closeContextMenu(); });
  on(window, 'keydown', (e) => { if (e.key === 'Escape' && !ctx.hidden) closeContextMenu(); });
}

function openContextMenu(id, x, y) {
  ctx.replaceChildren();
  const only = state.tabs.length <= 1;
  ctxItem('Reload', '', () => window.pane.reloadTab(id));
  ctxItem('Duplicate', '', () => window.pane.duplicateTab(id));
  ctxSep();
  ctxItem('Close tab', 'Ctrl+W', () => window.pane.closeTab(id));
  ctxItem('Close other tabs', '', () => window.pane.closeOtherTabs(id), only);
  ctxSep();
  ctxItem('Reopen closed tab', 'Ctrl+Shift+T', () => window.pane.reopenClosedTab(), !state.canReopen);

  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  ctx.style.top = `${y}px`;
  openOverlay(closeContextMenu, Math.ceil(ctx.getBoundingClientRect().bottom + 8));
  focusFirstItem(ctx); // keyboard can drive the menu once it's open
}

function closeContextMenu() {
  if (ctx.hidden) return;
  ctx.hidden = true;
  closeOverlay(closeContextMenu);
}

function ctxItem(label, hint, action, disabled = false) {
  const row = document.createElement('div');
  row.className = 'm-row' + (disabled ? ' disabled' : '');
  row.setAttribute('role', 'menuitem');
  if (disabled) row.setAttribute('aria-disabled', 'true');
  else row.tabIndex = -1;
  row.innerHTML = `<span class="m-label">${label}</span>` + (hint ? `<span class="m-key">${hint}</span>` : '');
  if (!disabled) on(row, 'click', () => { action(); closeContextMenu(); });
  ctx.append(row);
}

function ctxSep() {
  const s = document.createElement('div');
  s.className = 'm-sep';
  ctx.append(s);
}
