import { protocol } from 'electron';
import { INTERNAL_SCHEME, parseInternalErrorUrl } from '../../shared/internal-pages';
import { getSettingsSync } from '../settings';
import { searchBaseFor } from './url';
import {
  hostOf,
  renderErrorPage,
  renderNewTab,
  renderNotFound,
} from './internal-page-render';

/**
 * Serves the `maru://` internal pages — a new-tab start page and a custom
 * load-error page — modeled on pane's `pane://` rail (reference/pane/DESIGN.md
 * §14). Two halves, mirroring electron/plugins/protocol.ts:
 *
 *  - {@link registerInternalPagesScheme} runs BEFORE app-ready to mark the
 *    scheme standard + secure (a real, addressable origin).
 *  - {@link registerInternalPagesProtocol} runs after ready and answers requests
 *    with self-contained HTML (no fs, no bundler — identical in dev / packaged).
 *
 * The pages are pure HTML/CSS (renderers in ./internal-page-render.ts); Retry /
 * Search are plain `<a href>` links, so the CSP forbids all script and all
 * network egress.
 */

const INTERNAL_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "script-src 'none'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Mark the scheme privileged. MUST be called before app `ready`. */
export function registerInternalPagesScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: INTERNAL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
      },
    },
  ]);
}

/** Install the request handler. Call after app `ready`. */
export function registerInternalPagesProtocol(): void {
  protocol.handle(INTERNAL_SCHEME, (request) => {
    let page: string;
    try {
      page = new URL(request.url).hostname;
    } catch {
      return htmlResponse(renderNotFound(''), 400);
    }
    if (page === 'newtab') return htmlResponse(renderNewTab());
    if (page === 'error') {
      const info = parseInternalErrorUrl(request.url) ?? {
        failedUrl: '',
        code: 0,
        description: '',
      };
      const searchBase = searchBaseFor(getSettingsSync().browser.searchEngine);
      const query = hostOf(info.failedUrl) || info.failedUrl;
      const searchHref = searchBase + encodeURIComponent(query);
      return htmlResponse(renderErrorPage(info, searchHref));
    }
    return htmlResponse(renderNotFound(page), 404);
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': INTERNAL_CSP,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Exposed for the headless harness: the page CSP. */
export const __test = { INTERNAL_CSP };
