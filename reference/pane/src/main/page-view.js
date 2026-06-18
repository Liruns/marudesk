'use strict';
const path = require('node:path');
const { WebContentsView } = require('electron');
const { EventEmitter } = require('node:events');
const { canGoBack, canGoForward, goBack, goForward } = require('./nav-history');
const { attachPageContextMenu } = require('./page-context-menu');
const { COLORS } = require('../shared/config');

const isInternalUrl = (u) => typeof u === 'string' && u.startsWith('pane://');

/**
 * One web-page surface — a native WebContentsView plus its navigation behavior.
 * Internal surfaces (new-tab, error, …) are served over the pane:// protocol.
 * Emits: 'loading'(bool), 'nav-state'(...), 'load-error'(...), 'title'(string),
 *        'favicon'(url), 'navigated'(url), 'found'(result), 'open-external'(url),
 *        'open-tab'(url, {background}), 'inspect'(x, y)  — the last two from the right-click menu.
 */
class PageView extends EventEmitter {
  constructor() {
    super();
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'page.js'), // scoped to pane:// pages
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.view.setBackgroundColor(COLORS.canvas); // seam-hider (DESIGN §2)
    this._displayUrl = null;    // address-bar override for internal pages
    this._internalLoad = false; // suppress the loading bar for instant local pages
    this._loading = false;      // current load state, re-read on tab activation (toolbar bar/glyph)
    this._certAllow = new Set(); // hosts the user chose to proceed to past a cert error
    this._dtView = null; // lazily-created devtools host (a WebContentsView; DESIGN §4 docked devtools)
    this._dtMode = null; // 'right' | 'bottom' | 'detach' | null — this tab's devtools placement
    this._wireEvents();
  }

  get webContents() { return this.view.webContents; }

  _wireEvents() {
    const wc = this.webContents;

    wc.on('did-start-loading', () => { if (!this._internalLoad) { this._loading = true; this.emit('loading', true); } });
    wc.on('did-stop-loading', () => { this._internalLoad = false; this._loading = false; this.emit('loading', false); this._emitState(); });

    // Electron 42: navigation-start events deliver a single `details` object
    // ({ url, isSameDocument, isMainFrame, ... }) — not the old positional args.
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      if (isInternalUrl(details.url)) { this._internalLoad = true; return; }
      this._displayUrl = null;
      this._loading = true;
      this.emit('favicon', '');
      this.emit('loading', true);
    });

    wc.on('did-navigate', (_e, url) => { this.emit('navigated', url); this._emitState(); });
    wc.on('did-navigate-in-page', () => this._emitState());

    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && !isInternalUrl(url)) this.loadError(url, code, desc);
    });

    wc.on('page-title-updated', (_e, title) => this.emit('title', title));
    wc.on('page-favicon-updated', (_e, favs) => this.emit('favicon', (favs && favs[0]) || ''));
    wc.on('found-in-page', (_e, result) => this.emit('found', result));
    wc.on('devtools-opened', () => this.emit('devtools', true));
    // Closing from the devtools UI itself (or its detached window) must reset our placement so the
    // window's next reconcile tears the dock/satellite down — otherwise the icon lies (DESIGN §14).
    wc.on('devtools-closed', () => { this._dtMode = null; this.emit('devtools', false); });

    // Cert errors (DESIGN §14): block by default → the failed load falls to the error page, which
    // offers an explicit "Proceed anyway". Proceeding calls allowCert(host) and reloads; on the
    // retry this host is trusted for this tab only. Never auto-trust.
    wc.on('certificate-error', (event, url, _error, _cert, callback) => {
      let host = url; try { host = new URL(url).host; } catch { /* keep raw */ }
      event.preventDefault();
      callback(this._certAllow.has(host));
    });

    wc.setWindowOpenHandler(({ url }) => {
      this.emit('open-external', url);
      return { action: 'deny' };
    });

    // Hardening: a web page must not script its way into a privileged pane:// surface.
    // Our own loads use loadURL (which doesn't fire will-navigate); intra-pane links are
    // allowed. Blocks `location = 'pane://…'` / link clicks from web content.
    wc.on('will-navigate', (e, url) => {
      if (url.startsWith('pane://') && !wc.getURL().startsWith('pane://')) e.preventDefault();
    });

    // Native right-click menu (link / image / editable / selection / page + Inspect). Its
    // orchestrated actions bubble back out as this view's 'open-tab' / 'inspect' events.
    attachPageContextMenu(this);
  }

  _emitState() {
    const wc = this.webContents;
    const real = wc.getURL();
    const url = this._displayUrl !== null ? this._displayUrl : (isInternalUrl(real) ? '' : real);
    this.emit('nav-state', { url, canGoBack: canGoBack(wc), canGoForward: canGoForward(wc) });
  }

  navigate(url) { this.webContents.loadURL(url); }

  /** Re-emit the current nav state (used when this tab becomes active). */
  refreshState() { this._emitState(); }

  /** Release the webContents when the tab is closed. */
  destroy() {
    // Drop our listeners FIRST so the closeDevtools() below can't re-enter the window's reconcile
    // during teardown: closeDevtools sets _dtMode directly and doesn't need the devtools-closed
    // handler, and suppressing the 'devtools' re-emit here avoids a reconcile against a dying tab.
    this.removeAllListeners();
    this.closeDevtools();  // close the session while the page wc is still alive
    this.destroyDtHost();  // then retire the host view
    const wc = this.webContents;
    if (wc && !wc.isDestroyed() && typeof wc.close === 'function') {
      try { wc.close(); } catch { /* already gone */ }
    }
  }

  /** The new-tab / start page (DESIGN §14). */
  loadStart() {
    this._displayUrl = '';
    this._internalLoad = true;
    this.webContents.loadURL('pane://newtab/');
  }

  /** The custom error surface (DESIGN §14). Keeps the attempted URL in the address bar. */
  loadError(url, code, desc) {
    this._displayUrl = url || '';
    this._internalLoad = true;
    this._loading = false;
    this.emit('loading', false);
    this.emit('load-error', { code, desc, url });
    const q = new URLSearchParams({ url: url || '', code: String(code ?? ''), desc: desc || '' });
    this.webContents.loadURL('pane://error/?' + q.toString());
  }

  back() { if (this.canGoBack()) goBack(this.webContents); }
  forward() { if (this.canGoForward()) goForward(this.webContents); }
  reload() { this.webContents.reload(); }
  stop() { this.webContents.stop(); }
  canGoBack() { return canGoBack(this.webContents); }
  canGoForward() { return canGoForward(this.webContents); }
  isLoading() { return this._loading; }
  isDevToolsOpen() { return this._dtMode !== null; }
  allowCert(host) { if (host) this._certAllow.add(host); } // user chose "Proceed anyway" for this host

  /* ── Devtools host (DESIGN §4) ────────────────────────────────────────────
     The window owns placement; a PageView owns its devtools' contents. Each tab keeps its own
     host view so devtools state survives tab switches. The page's devtools front-end is rendered
     INTO this host (setDevToolsWebContents) — the only way to dock devtools inside custom chrome;
     Chromium's native docking ignores a WebContentsView layout. Detach reparents the same host
     into a satellite window, so all three modes share one proven mechanism. */
  get devtoolsView() { return this._dtView; }
  get devtoolsMode() { return this._dtMode; }

  _ensureDtView() {
    if (!this._dtView) {
      this._dtView = new WebContentsView();
      this._dtView.setBackgroundColor(COLORS.canvas); // dark while devtools paints, never a white flash
    }
    return this._dtView;
  }

  /** Record the desired placement and make sure the host view exists (does not open devtools). */
  setMode(mode) { this._dtMode = mode; this._ensureDtView(); }

  /** Point the page's devtools at our host and open them. Idempotent; detach mode is honored
   *  because we control where the host view lives, not Chromium. */
  ensureOpen() {
    const wc = this.webContents;
    if (wc.isDestroyed() || !this._dtView) return;
    if (!wc.isDevToolsOpened()) {
      wc.setDevToolsWebContents(this._dtView.webContents);
      wc.openDevTools({ mode: 'detach' }); // 'detach' = don't let Chromium dock into the native frame
    }
  }

  /** Close the devtools session (the host view is kept for reuse until destroyDtHost). */
  closeDevtools() {
    this._dtMode = null;
    const wc = this.webContents;
    if (!wc.isDestroyed() && wc.isDevToolsOpened()) wc.closeDevTools();
  }

  /** Tear down the host view itself (on retire/tab-close). */
  destroyDtHost() {
    if (this._dtView) {
      const wc = this._dtView.webContents;
      if (wc && !wc.isDestroyed() && typeof wc.close === 'function') {
        try { wc.close(); } catch { /* already gone */ }
      }
      this._dtView = null;
    }
  }

  zoomBy(delta) {
    const wc = this.webContents;
    wc.setZoomLevel(Math.max(-3, Math.min(5, wc.getZoomLevel() + delta)));
  }
  resetZoom() { this.webContents.setZoomLevel(0); }

  findInPage(text, opts) { if (text) this.webContents.findInPage(text, opts); }
  stopFind() { this.webContents.stopFindInPage('clearSelection'); }
}

module.exports = PageView;
