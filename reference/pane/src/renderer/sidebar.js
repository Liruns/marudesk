// The vertical-tabs rail (DESIGN §11 Arc/Zen lineage) — renders the tab list as a left column and
// routes clicks/drags/right-clicks back as tab actions. A sibling of features/tabs.js (the top
// strip): both subscribe to the same TABS_STATE, so they stay in lock-step. This runs in its own
// WebContentsView (the rail) with the same window.pane bridge as the toolbar. Its context menu is
// self-contained (a positioned div in THIS view) — it can't use the chrome-grow overlay, which
// lives in the toolbar's separate view.
import { $, on } from './lib/dom.js';
import { ICONS } from './lib/icons.js';
import { initMenuNav, focusFirstItem } from './lib/menu-nav.js';

// Only let web favicons into the privileged chrome document (no file:/pane:/js: schemes).
const SAFE_FAVICON = /^(?:https?|data):/i;

let state = { tabs: [], activeId: null, canReopen: false };
let dragId = null;
let ctx; // the right-click context-menu panel

const list = $('#vtabs');

on($('#vnewtab'), 'click', () => window.pane.newTab());
window.pane.onTabs((s) => { state = s; if (dragId == null) render(s); });
initDrag();
initKeyboard();
initContextMenu();

// Vertical tablist keyboard: Up/Down move focus between tabs (roving), Enter/Space activates.
// (Ctrl+Tab still cycles the active tab; that's handled in the main process.)
function initKeyboard() {
  on(list, 'keydown', (e) => {
    const el = e.target.closest('.vtab');
    if (!el) return;
    const els = [...list.querySelectorAll('.vtab')];
    const i = els.indexOf(el);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length].focus();
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

function render(s) {
  // Preserve keyboard focus across the rebuild (a background tab can update mid arrow-nav).
  const act = document.activeElement;
  const focusedId = act && act.classList && act.classList.contains('vtab') ? Number(act.dataset.id) : null;

  list.replaceChildren();
  for (const t of s.tabs) {
    const isActive = t.id === s.activeId;
    const tab = document.createElement('div');
    tab.className = 'vtab' + (isActive ? ' active' : '') + (t.loading ? ' loading' : '');
    tab.title = t.url || t.title || '';
    tab.draggable = true;
    tab.dataset.id = t.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.tabIndex = isActive ? 0 : -1; // roving: the active tab is the rail's single tab-stop

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title || 'New Tab';

    const close = document.createElement('button');
    close.className = 'close';
    close.setAttribute('aria-label', 'Close tab');
    close.tabIndex = -1; // keep the rail one tab-stop; close via Ctrl+W or click
    close.innerHTML = ICONS.close;

    tab.append(faviconEl(t), title, close);
    on(tab, 'click', () => window.pane.activateTab(t.id));
    on(close, 'click', (e) => { e.stopPropagation(); window.pane.closeTab(t.id); });
    list.append(tab);
  }

  // Restore focus only while the rail itself holds focus — otherwise activating a tab
  // (which focuses the page) would immediately steal focus back to the rail.
  if (focusedId != null && document.hasFocus()) {
    const refocus = [...list.children].find((el) => Number(el.dataset.id) === focusedId);
    if (refocus) refocus.focus();
  }
}

/* ── Drag to reorder (vertical: clientY) ────────────────────────────────────
   Delegated on the list so handlers survive every re-render. `pos` is the slot
   in the *current* list before which to drop; main reconciles it. */
function initDrag() {
  on(list, 'dragstart', (e) => {
    const el = e.target.closest('.vtab');
    if (!el) return;
    dragId = Number(el.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  on(list, 'dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    mark(e);
  });
  on(list, 'drop', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    window.pane.moveTab(dragId, dropPos(e));
    endDrag();
  });
  on(list, 'dragend', () => endDrag());
}

function dropPos(e) {
  const els = [...list.querySelectorAll('.vtab')];
  const target = e.target.closest('.vtab');
  if (!target) return els.length; // dropped past the last tab → append
  const j = els.indexOf(target);
  const r = target.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2 ? j + 1 : j;
}

function mark(e) {
  clearDropMarks();
  const target = e.target.closest('.vtab');
  if (!target || Number(target.dataset.id) === dragId) return; // don't mark the dragged tab itself
  const r = target.getBoundingClientRect();
  target.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
}

// Clear only the drop-slot indicators — the dragged tab keeps `.dragging` until the drag ends.
function clearDropMarks() {
  for (const el of list.querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

function endDrag() {
  clearDropMarks();
  const dragged = list.querySelector('.dragging');
  if (dragged) dragged.classList.remove('dragging');
  dragId = null;
}

/* ── Right-click context menu (self-contained within the rail view) ────────── */
function initContextMenu() {
  ctx = document.createElement('div');
  ctx.className = 'ctx-menu';
  ctx.setAttribute('role', 'menu');
  ctx.hidden = true;
  document.body.append(ctx);
  initMenuNav(ctx);

  on(list, 'contextmenu', (e) => {
    const el = e.target.closest('.vtab');
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
  // Clamp into the rail view (a narrow rectangle) so the menu never renders clipped off an edge.
  const r = ctx.getBoundingClientRect();
  ctx.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  ctx.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  focusFirstItem(ctx); // keyboard can drive the menu once it's open
}

function closeContextMenu() {
  if (ctx.hidden) return;
  ctx.hidden = true;
}

function ctxItem(label, hint, action, disabled = false) {
  const row = document.createElement('div');
  row.className = 'm-row' + (disabled ? ' disabled' : '');
  row.setAttribute('role', 'menuitem');
  if (disabled) row.setAttribute('aria-disabled', 'true');
  else row.tabIndex = -1;
  const lab = document.createElement('span');
  lab.className = 'm-label';
  lab.textContent = label;
  row.append(lab);
  if (hint) {
    const k = document.createElement('span');
    k.className = 'm-key';
    k.textContent = hint;
    row.append(k);
  }
  if (!disabled) on(row, 'click', () => { action(); closeContextMenu(); });
  ctx.append(row);
}

function ctxSep() {
  const s = document.createElement('div');
  s.className = 'm-sep';
  ctx.append(s);
}
