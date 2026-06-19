// Back / forward / reload(↔stop) / devtools buttons + their state.
import { $, on } from '../lib/dom.js';
import { ICONS } from '../lib/icons.js';
import { openOverlay, closeOverlay } from '../lib/overlay.js';
import { initMenuNav, focusFirstItem } from '../lib/menu-nav.js';

export function initNavigation() {
  const back = $('#back');
  const forward = $('#forward');
  const reload = $('#reload');
  const devtools = $('#devtools');
  let loading = false;
  let dock = null; // active devtools placement: 'right' | 'bottom' | 'detach' | null

  on(back, 'click', () => window.pane.back());
  on(forward, 'click', () => window.pane.forward());
  on(reload, 'click', () => (loading ? window.pane.stop() : window.pane.reload()));
  on(devtools, 'click', () => window.pane.toggleDevTools()); // opens at the last-used side; state via onDevToolsState

  // Right-click the DevTools button to choose where it docks (DESIGN §4).
  const menu = initDockMenu(devtools, () => dock);
  on(devtools, 'contextmenu', (e) => { e.preventDefault(); menu.open(); });

  // Drive the active (#2997ff) state and the dock indicator from the REAL devtools state, not an
  // optimistic toggle, so they stay correct across keyboard toggle, dock changes, closing the
  // detached window, and tab switches (DESIGN §4/§14).
  window.pane.onDevToolsState((d) => {
    dock = d && d.open ? d.dock : null;
    devtools.classList.toggle('active', !!(d && d.open));
  });

  window.pane.onNavState((d) => {
    back.disabled = !d.canGoBack;
    forward.disabled = !d.canGoForward;
  });

  // Reload ↔ Stop swap while the active tab is loading.
  window.pane.onLoading((d) => {
    loading = d.loading;
    reload.innerHTML = loading ? ICONS.close : ICONS.reload;
    reload.title = loading ? 'Stop' : 'Reload (Ctrl+R)';
    reload.setAttribute('aria-label', loading ? 'Stop' : 'Reload');
  });
}

/* The devtools dock picker — a small popover under the DevTools button. Mirrors the tab
   context-menu grammar; the current side is marked blue. `getDock` reads the live placement. */
function initDockMenu(anchor, getDock) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.append(menu);
  initMenuNav(menu);

  const close = () => { if (menu.hidden) return; menu.hidden = true; closeOverlay(close); };

  const row = (label, side, cur) => {
    const el = document.createElement('div');
    el.className = 'm-row' + (side === cur ? ' active' : '');
    el.setAttribute('role', 'menuitem');
    el.tabIndex = -1;
    el.innerHTML = `<span class="m-label">${label}</span>`;
    on(el, 'click', () => { window.pane.setDevtoolsDock(side); close(); });
    menu.append(el);
  };

  const open = () => {
    const cur = getDock();
    menu.replaceChildren();
    row('Dock right', 'right', cur);
    row('Dock bottom', 'bottom', cur);
    row('Detach', 'detach', cur);
    menu.hidden = false;
    // Right-align under the button, clamped into the window.
    const a = anchor.getBoundingClientRect();
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(a.right - r.width, window.innerWidth - r.width - 8))}px`;
    menu.style.top = `${a.bottom + 4}px`;
    openOverlay(close, Math.ceil(menu.getBoundingClientRect().bottom + 8));
    focusFirstItem(menu);
  };

  on(window, 'mousedown', (e) => { if (!menu.hidden && !e.target.closest('.ctx-menu')) close(); });
  on(window, 'keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) close(); });
  return { open, close };
}
