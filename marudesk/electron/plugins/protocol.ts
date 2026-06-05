import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { protocol } from 'electron';
import { PLUGIN_SCHEME } from '../../shared/plugin';
import { resolvePluginPanelFile } from './index';

/**
 * The `plugin://` scheme that serves a plugin's sandboxed UI panel files (v2,
 * docs/plugin-runtime-design.md §8.5). Two halves:
 *
 *  - {@link registerPluginScheme} runs BEFORE app-ready to mark the scheme
 *    standard + secure so an `<iframe sandbox>` can load it with its own opaque
 *    origin and honor a per-response CSP.
 *  - {@link registerPluginProtocol} runs after ready and answers requests. It maps
 *    `plugin://<id>/<relpath>` to a file ONLY via the manager's resolver, which
 *    serves an active, `ui`-granted plugin's own folder with no traversal — so a
 *    panel can't read another plugin, the workspace, or arbitrary disk.
 *
 * Every response carries a strict CSP: no default sources, inline script/style for
 * the plugin's own page, images from itself/data:, and — crucially — `connect-src
 * 'none'`, so a panel has NO network egress (it drives work through the postMessage
 * bridge's insert-prompt, never by phoning home).
 */

const PANEL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' plugin:",
  "style-src 'unsafe-inline' plugin:",
  "img-src plugin: data:",
  "font-src plugin: data:",
  "media-src plugin: data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** Mark the scheme privileged. MUST be called before app `ready`. */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
    },
  ]);
}

/** Build a response with the panel CSP + the right content type (or a bare 4xx). */
function deny(status: number): Response {
  return new Response('', { status, headers: { 'Content-Security-Policy': "default-src 'none'" } });
}

/** Install the request handler. Call after app `ready`. */
export function registerPluginProtocol(): void {
  protocol.handle(PLUGIN_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return deny(400);
    }
    // plugin://<id>/<relpath> — host is the plugin id, pathname the file.
    const pluginId = url.hostname;
    const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!pluginId || !relPath) return deny(404);
    const abs = resolvePluginPanelFile(pluginId, relPath);
    if (!abs) return deny(404);
    try {
      const body = await readFile(abs);
      const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Security-Policy': PANEL_CSP,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return deny(404);
    }
  });
}

/** Exposed for the headless harness: the CSP + a content-type lookup. */
export const __test = { PANEL_CSP, CONTENT_TYPES };
