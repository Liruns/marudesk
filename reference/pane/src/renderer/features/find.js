// Find-in-page bar (Ctrl+F). A chrome overlay (top-right) that drives webContents.findInPage
// on the active tab and shows the active/total match count.
import { $, on } from '../lib/dom.js';
import { openOverlay, closeOverlay } from '../lib/overlay.js';
import { ICONS } from '../lib/icons.js';

let bar, input, countEl;

export function initFind() {
  bar = document.createElement('div');
  bar.id = 'findbar';
  bar.hidden = true;
  bar.innerHTML =
    '<input id="find-input" type="text" placeholder="Find in page" spellcheck="false" autocomplete="off" />' +
    '<span class="find-count" id="find-count"></span>' +
    `<button class="find-btn" id="find-prev" title="Previous (Shift+Enter)" aria-label="Previous">${ICONS.chevronUp}</button>` +
    `<button class="find-btn" id="find-next" title="Next (Enter)" aria-label="Next">${ICONS.chevronDown}</button>` +
    `<button class="find-btn" id="find-close" title="Close (Esc)" aria-label="Close">${ICONS.close}</button>`;
  document.body.append(bar);
  input = $('#find-input');
  countEl = $('#find-count');

  on(input, 'input', () => {
    if (input.value) window.pane.find(input.value, { findNext: false });
    else { window.pane.stopFind(); countEl.textContent = ''; }
  });
  on(input, 'keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (input.value) window.pane.find(input.value, { forward: !e.shiftKey, findNext: true }); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  on($('#find-next'), 'click', () => { if (input.value) window.pane.find(input.value, { forward: true, findNext: true }); });
  on($('#find-prev'), 'click', () => { if (input.value) window.pane.find(input.value, { forward: false, findNext: true }); });
  on($('#find-close'), 'click', () => close());

  window.pane.onOpenFind(() => open());
  window.pane.onFound((r) => {
    countEl.textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : 'No results';
  });
}

function open() {
  bar.hidden = false;
  input.focus();
  input.select();
  if (input.value) window.pane.find(input.value, { findNext: false });

  bar.style.top = `${Math.ceil($('#toolbar').getBoundingClientRect().bottom) + 8}px`;
  bar.style.left = `${window.innerWidth - bar.getBoundingClientRect().width - 12}px`;
  openOverlay(close, Math.ceil(bar.getBoundingClientRect().bottom + 8));
}

function close() {
  if (bar.hidden) return;
  bar.hidden = true;
  window.pane.stopFind();
  countEl.textContent = '';
  closeOverlay(close);
}
