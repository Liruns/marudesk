'use strict';
// The pane:// internal-pages rail. pane://<host>/<path> serves src/internal/<host>/<path>;
// pane://assets/* reuses src/renderer/assets/*. Privileged (standard + secure) so it's a
// real origin with back/forward, addressability, and a clean preload guard.
const { protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const INTERNAL = path.join(__dirname, '..', 'internal');
const ASSETS = path.join(__dirname, '..', 'renderer', 'assets');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

/** Call before app 'ready'. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    // corsEnabled: a custom standard scheme blocks cross-origin fetches at the scheme level
    // (Chromium) unless this is set — needed so pane://<page> can load pane://assets/* (the font).
    { scheme: 'pane', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

/** Call after app 'ready'. */
function handle() {
  protocol.handle('pane', (request) => {
    const url = new URL(request.url);
    const root = url.hostname === 'assets' ? ASSETS : path.join(INTERNAL, url.hostname);
    let rel;
    try { rel = decodeURIComponent(url.pathname); }
    catch { return new Response('Bad request', { status: 400 }); } // malformed %-escape must not throw
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(root, rel));
    if (!filePath.startsWith(path.normalize(root))) return new Response('Forbidden', { status: 403 });
    try {
      const data = fs.readFileSync(filePath);
      return new Response(data, { headers: {
        'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        // pane://<page> fetching pane://assets/* (e.g. the bundled Inter font) is cross-origin under
        // the standard scheme; without this the font fetch is CORS-blocked and silently falls back.
        'access-control-allow-origin': '*',
      } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

module.exports = { registerScheme, handle };
