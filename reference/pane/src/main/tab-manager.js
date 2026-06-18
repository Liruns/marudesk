'use strict';
const { EventEmitter } = require('node:events');
const PageView = require('./page-view');
const { handlePageKey } = require('./shortcuts');
const history = require('./history');

/**
 * Owns the set of tabs (one PageView each) and which is active. Only the active
 * tab's view is shown by the window; background tabs keep running.
 *
 * Emits: 'active-page'(PageView), 'tabs'(state), 'all-closed', 'focus-address',
 *        re-emits the ACTIVE tab's 'loading'/'nav-state'/'load-error'/'inspect', and any
 *        tab's 'open-external'.
 */
class TabManager extends EventEmitter {
  constructor() {
    super();
    this.tabs = [];
    this.activeId = null;
    this._seq = 0;
    this._closed = []; // recently-closed snapshots ({ url, index }) for Ctrl+Shift+T
  }

  get active() {
    const t = this.tabs.find((x) => x.id === this.activeId);
    return t ? t.view : null;
  }

  _state() {
    return {
      activeId: this.activeId,
      canReopen: this._closed.length > 0,
      tabs: this.tabs.map((t) => ({
        id: t.id, title: t.title, url: t.url, loading: t.loading, favicon: t.favicon,
      })),
    };
  }
  _emitTabs() { this.emit('tabs', this._state()); }

  /** Open a tab. `index` (optional) inserts it at that slot; default appends to the end.
   *  `opts.background` opens it without stealing focus (a context-menu "Open in New Tab"). */
  newTab(url, index, opts) {
    const id = ++this._seq;
    const view = new PageView();
    const tab = { id, view, title: 'New Tab', url: '', loading: false, favicon: '' };
    const at = Number.isInteger(index) ? Math.max(0, Math.min(index, this.tabs.length)) : this.tabs.length;
    this.tabs.splice(at, 0, tab);

    view.on('title', (title) => {
      tab.title = title || 'New Tab';
      history.updateTitle(tab._recordedUrl || tab.url, title); // key on the URL actually recorded (tab.url lags behind page-title-updated)
      this._emitTabs();
    });
    view.on('navigated', (navUrl) => { tab._recordedUrl = navUrl; history.record(navUrl); });
    view.on('favicon', (f) => { tab.favicon = f; this._emitTabs(); });
    view.on('found', (r) => { if (id === this.activeId) this.emit('found', r); });
    view.on('loading', (loading) => {
      tab.loading = loading;
      this._emitTabs();
      if (id === this.activeId) this.emit('loading', loading);
    });
    view.on('nav-state', (state) => {
      tab.url = state.url;
      this._emitTabs();
      if (id === this.activeId) this.emit('nav-state', state);
    });
    view.on('load-error', (err) => { if (id === this.activeId) this.emit('load-error', err); });
    view.on('devtools', (open) => { if (id === this.activeId) this.emit('devtools', open); });
    view.on('open-external', (u) => this.emit('open-external', u));
    // Right-click menu: open a link/image/search in a tab right after this one; route Inspect to the
    // window (it owns the devtools dock). Inspect only fires on the active tab — the menu can't open
    // on an unmounted background view — but gate it anyway.
    view.on('open-tab', (u, o) => {
      const i = this.tabs.findIndex((t) => t.id === id);
      this.newTab(u, i === -1 ? undefined : i + 1, o); // source tab already gone → append, not index 0
    });
    view.on('inspect', (x, y) => { if (id === this.activeId) this.emit('inspect', x, y); });
    view.webContents.on('before-input-event', (e, input) => handlePageKey(this, e, input));

    // Background tabs load without stealing focus; the first tab must activate regardless (there's
    // no other active tab to keep). Either way _emitTabs runs so the strip shows the newcomer.
    const background = !!(opts && opts.background) && this.activeId !== null;
    if (background) this._emitTabs(); else this.activate(id);
    if (url) view.navigate(url); else view.loadStart();
    return id;
  }

  activate(id) {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.activeId = id;
    const view = this.active;
    this.emit('active-page', view);
    this._emitTabs();
    // Re-sync the toolbar's per-active signals (loading bar, Reload/Stop glyph, devtools icon) —
    // refreshState() only re-emits nav-state, so without these a tab switch leaves them stale.
    if (view) { view.refreshState(); this.emit('loading', view.isLoading()); this.emit('devtools', view.isDevToolsOpen()); }
  }

  /** Re-emit the current state — used after the toolbar renderer (re)loads. */
  refresh() {
    this._emitTabs();
    const view = this.active;
    if (view) { view.refreshState(); this.emit('loading', view.isLoading()); this.emit('devtools', view.isDevToolsOpen()); }
  }

  nextTab() { this._cycle(1); }
  prevTab() { this._cycle(-1); }
  _cycle(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = this.tabs[(i + dir + this.tabs.length) % this.tabs.length];
    this.activate(next.id);
  }

  closeActive() { if (this.activeId != null) this.closeTab(this.activeId); }

  closeTab(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    const wasActive = this.activeId === id;
    // Remember it so Ctrl+Shift+T can bring it back. Internal pages (new-tab, history, …)
    // report an empty url, so this naturally skips them — only real pages are restorable.
    if (tab.url) {
      this._closed.push({ url: tab.url, index: idx });
      if (this._closed.length > 25) this._closed.shift();
    }
    this.tabs.splice(idx, 1);
    this.emit('tab-closed', tab.view); // let the window retire any devtools dock/satellite for this view

    if (this.tabs.length === 0) {
      this.emit('all-closed');
      tab.view.destroy();
      return;
    }
    if (wasActive) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activate(next.id);
    } else {
      this._emitTabs();
    }
    tab.view.destroy();
  }

  /** Re-open the most recently closed tab at its old slot (Ctrl+Shift+T). */
  reopenClosed() {
    const snap = this._closed.pop();
    if (snap) this.newTab(snap.url, snap.index);
  }

  /** Reorder: move `id` so it sits at `pos` in the current list (0 = first). */
  moveTab(id, pos) {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from === -1) return;
    const [tab] = this.tabs.splice(from, 1);
    // `pos` is measured against the list *including* the dragged tab; after removing it,
    // every slot past `from` shifts down by one.
    let to = pos > from ? pos - 1 : pos;
    to = Math.max(0, Math.min(to, this.tabs.length));
    if (to === from) { this.tabs.splice(from, 0, tab); return; }
    this.tabs.splice(to, 0, tab);
    this._emitTabs();
  }

  reloadTab(id) {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) tab.view.reload();
  }

  /** Open a copy of the tab's current page right after it. */
  duplicate(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const real = this.tabs[idx].view.webContents.getURL();
    const url = real && !real.startsWith('pane://') ? real : undefined; // internal pages → fresh start page, not a raw pane:// reload
    this.newTab(url, idx + 1);
  }

  /** Close every tab except `id`. */
  closeOthers(id) {
    for (const t of this.tabs.slice()) if (t.id !== id) this.closeTab(t.id);
  }
}

module.exports = TabManager;
