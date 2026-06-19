'use strict';
// Keyboard handling for a tab's webContents (page-focus case). Routes to the TabManager.
// Wired per-tab in TabManager.newTab so shortcuts work in every tab. The chrome-focus
// case (toolbar/tabstrip focused) is handled in the renderer.
const bookmarks = require('./bookmarks');

function handlePageKey(tabs, e, input) {
  if (input.type !== 'keyDown') return;
  const mod = input.control || input.meta;
  const key = (input.key || '').toLowerCase();
  const active = tabs.active;

  if (mod && key === 'l') { tabs.emit('focus-address'); e.preventDefault(); }
  else if (mod && input.shift && key === 't') { tabs.reopenClosed(); e.preventDefault(); }
  else if (mod && key === 't') { tabs.newTab(); e.preventDefault(); }
  else if (mod && key === 'w') { tabs.closeActive(); e.preventDefault(); }
  else if (mod && key === 'tab') { input.shift ? tabs.prevTab() : tabs.nextTab(); e.preventDefault(); }
  else if (mod && key === 'r') { if (active) active.reload(); e.preventDefault(); }
  else if (mod && key === 'f') { tabs.emit('open-find'); e.preventDefault(); }
  else if (mod && key === 'k') { tabs.emit('open-palette'); e.preventDefault(); }
  else if (mod && key === 'h') { if (active) active.navigate('pane://history/'); e.preventDefault(); }
  else if (mod && key === 'j') { if (active) active.navigate('pane://downloads/'); e.preventDefault(); }
  else if (mod && input.key === ',') { if (active) active.navigate('pane://settings/'); e.preventDefault(); }
  else if (mod && key === 'd') {
    if (active) {
      const wc = active.webContents;
      const r = bookmarks.toggle(wc.getURL(), wc.getTitle());
      if (r !== null) tabs.emit('toast', r ? 'Bookmarked' : 'Removed from bookmarks');
    }
    e.preventDefault();
  }
  else if (mod && (input.key === '=' || input.key === '+')) { if (active) active.zoomBy(0.5); e.preventDefault(); }
  else if (mod && input.key === '-') { if (active) active.zoomBy(-0.5); e.preventDefault(); }
  else if (mod && input.key === '0') { if (active) active.resetZoom(); e.preventDefault(); }
  else if (mod && input.shift && key === 'i') { tabs.emit('devtools-toggle'); e.preventDefault(); }
  else if (mod && input.shift && key === 'e') { tabs.emit('toggle-vertical-tabs'); e.preventDefault(); }
  else if (input.alt && input.key === 'ArrowLeft' && active && active.canGoBack()) { active.back(); e.preventDefault(); }
  else if (input.alt && input.key === 'ArrowRight' && active && active.canGoForward()) { active.forward(); e.preventDefault(); }
}

module.exports = { handlePageKey };
