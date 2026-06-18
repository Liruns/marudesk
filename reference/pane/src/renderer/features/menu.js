// The ⋮ menu — a chrome overlay (via the overlay helper). A pure launcher: it opens
// pane:// internal pages (History, Settings). Settings logic lives on those pages, not here.
import { $, on } from '../lib/dom.js';
import { openOverlay, closeOverlay } from '../lib/overlay.js';
import { initMenuNav, focusFirstItem } from '../lib/menu-nav.js';

let panel, btn;
let verticalTabs = false; // mirrored from main via LAYOUT_STATE so the toggle shows the live state
let canvasMode = false;   // ditto — the infinite-canvas toggle reflects main's live mode

export function initMenu() {
  btn = $('#menu-btn');
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  panel = document.createElement('div');
  panel.id = 'menu';
  panel.setAttribute('role', 'menu');
  panel.hidden = true;
  document.body.append(panel);
  initMenuNav(panel);

  // Layout mode (vertical tabs on/off) is owned by main; keep the toggle in sync, and re-render if
  // the menu is open when it flips (e.g. toggled via Ctrl+Shift+E while the menu is showing).
  window.pane.onLayout((s) => {
    verticalTabs = !!s.verticalTabs;
    canvasMode = !!s.canvasMode;
    if (!panel.hidden) render();
  });

  on(btn, 'click', (e) => { e.stopPropagation(); panel.hidden ? open() : close(); });
  on(window, 'mousedown', (e) => {
    if (panel.hidden) return;
    if (e.target.closest('#menu') || e.target.closest('#menu-btn')) return;
    close();
  });
  // Escape closes and returns focus to the trigger (keyboard round-trip).
  on(window, 'keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { close(); btn.focus(); } });
}

function open() {
  render();

  const r = btn.getBoundingClientRect();
  panel.style.top = `${r.bottom + 6}px`;
  panel.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const pr = panel.getBoundingClientRect(); // measure to right-align under the button
  panel.style.left = `${Math.max(8, r.right - pr.width)}px`;
  openOverlay(close, Math.ceil(panel.getBoundingClientRect().bottom + 8));
  focusFirstItem(panel); // land keyboard focus in the menu so arrows/Enter work
}

function close() {
  if (panel.hidden) return;
  panel.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  closeOverlay(close);
}

function render() {
  panel.replaceChildren();
  // DESIGN §8: when the toolbar collapses the DevTools button at narrow widths, surface it here
  // so it stays reachable. Detect via the button's computed display (robust to the breakpoint).
  const dt = document.getElementById('devtools');
  if (dt && getComputedStyle(dt).display === 'none') {
    action('Toggle DevTools', 'Ctrl+Shift+I', () => window.pane.toggleDevTools());
    sep();
  }
  item('Bookmarks', '', 'pane://bookmarks/');
  item('History', 'Ctrl+H', 'pane://history/');
  item('Downloads', 'Ctrl+J', 'pane://downloads/');
  sep();
  toggle('Vertical tabs', verticalTabs, () => window.pane.setVerticalTabs(!verticalTabs));
  toggle('Canvas (beta)', canvasMode, () => window.pane.setCanvasMode(!canvasMode));
  sep();
  item('Settings', 'Ctrl+,', 'pane://settings/');
}

// A menu row that flips a boolean — rendered with the iOS-style switch (DESIGN §4 toggle grammar).
// role=menuitemcheckbox + aria-checked carries the state to assistive tech (menu-nav roves it too).
function toggle(label, active, fn) {
  const row = document.createElement('div');
  row.className = 'm-row toggle' + (active ? ' checked' : '');
  row.setAttribute('role', 'menuitemcheckbox');
  row.setAttribute('aria-checked', active ? 'true' : 'false');
  row.tabIndex = -1;
  const lab = document.createElement('span');
  lab.className = 'm-label';
  lab.textContent = label;
  const sw = document.createElement('span');
  sw.className = 'm-switch';
  sw.setAttribute('aria-hidden', 'true');
  row.append(lab, sw);
  on(row, 'click', () => { fn(); close(); });
  panel.append(row);
}

// A menu row that runs a callback instead of navigating (e.g. the collapsed DevTools toggle).
function action(label, hint, fn) {
  const row = document.createElement('div');
  row.className = 'm-row';
  row.setAttribute('role', 'menuitem');
  row.tabIndex = -1;
  row.innerHTML = `<span class="m-label">${label}</span>` + (hint ? `<span class="m-key">${hint}</span>` : '');
  on(row, 'click', () => { fn(); close(); });
  panel.append(row);
}

function item(label, hint, target) {
  const row = document.createElement('div');
  row.className = 'm-row';
  row.setAttribute('role', 'menuitem');
  row.tabIndex = -1;
  row.innerHTML = `<span class="m-label">${label}</span>` + (hint ? `<span class="m-key">${hint}</span>` : '');
  on(row, 'click', () => { window.pane.navigate(target); close(); });
  panel.append(row);
}

function sep() {
  const s = document.createElement('div');
  s.className = 'm-sep';
  panel.append(s);
}
