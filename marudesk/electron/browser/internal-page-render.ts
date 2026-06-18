import { INTERNAL_SCHEME, type InternalErrorInfo } from '../../shared/internal-pages';

/**
 * Pure HTML renderers for the `maru://` internal pages (no electron / no
 * settings imports), so they're unit-testable in isolation. The protocol wiring
 * + the search-engine lookup live in ./internal-pages.ts, which feeds the
 * resolved search URL into {@link renderErrorPage}.
 *
 * The pages paint pane's dark Apple aesthetic by default (reference/pane/DESIGN.md
 * §2 / §14) and flip to a clean light half under `prefers-color-scheme`. They
 * carry no script and need no network — Retry / Search are plain `<a href>`
 * links — so the protocol handler can ship them under a no-script, no-connect CSP.
 */

/** Escape for HTML text and double-quoted attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The host of a URL for display / search, falling back to the raw string. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Map a Chromium net error code to a specific, calm one-liner (pane §10 voice). */
export function errorHeadline(info: InternalErrorInfo): string {
  const host = hostOf(info.failedUrl) || 'the page';
  switch (info.code) {
    case -105: // ERR_NAME_NOT_RESOLVED
      return `${host} doesn’t resolve.`;
    case -106: // ERR_INTERNET_DISCONNECTED
      return 'You appear to be offline.';
    case -7: // ERR_TIMED_OUT
    case -118: // ERR_CONNECTION_TIMED_OUT
    case -109: // ERR_ADDRESS_UNREACHABLE
      return `${host} took too long to respond.`;
    case -102: // ERR_CONNECTION_REFUSED
      return `${host} refused the connection.`;
    case -101: // ERR_CONNECTION_RESET
      return 'The connection was reset.';
    case -200: // ERR_CERT_COMMON_NAME_INVALID
    case -201: // ERR_CERT_DATE_INVALID
    case -202: // ERR_CERT_AUTHORITY_INVALID
      return 'This connection isn’t private.';
    default:
      return `Can’t reach ${host}.`;
  }
}

// Shared page chrome: pane's dark Apple palette (DESIGN.md §2), Inter via the
// system stack, with a clean light half under prefers-color-scheme.
const PAGE_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #0a0a0b; --fg: #f5f5f7; --muted: rgba(245,245,247,0.62);
    --faint: rgba(245,245,247,0.38); --accent: #0071e3; --accent-fg: #fff;
    --hairline: rgba(255,255,255,0.12); --surface: rgba(255,255,255,0.05);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --faint: #8e8e93;
      --accent: #0071e3; --accent-fg: #fff;
      --hairline: rgba(0,0,0,0.12); --surface: rgba(0,0,0,0.04);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: Inter, "Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; letter-spacing: -0.006em;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; line-height: 1.45;
  }
  .wrap { width: 100%; max-width: 460px; text-align: center; }
  .greeting { font-size: 40px; font-weight: 590; letter-spacing: -0.02em; line-height: 1.08; }
  .sub { margin-top: 12px; color: var(--muted); font-size: 14px; }
  .mono { font-family: "JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Code", monospace; }
  h1 { font-size: 17px; font-weight: 590; letter-spacing: -0.011em; margin: 0; }
  .url {
    margin: 16px 0 4px; padding: 8px 12px; border-radius: 8px;
    background: var(--surface); color: var(--muted); font-size: 13px;
    word-break: break-all; border: 1px solid var(--hairline);
  }
  .desc { color: var(--faint); font-size: 12px; margin-top: 8px; }
  .actions { margin-top: 24px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
  a.btn {
    display: inline-flex; align-items: center; height: 32px; padding: 0 16px;
    border-radius: 980px; font-size: 13px; text-decoration: none;
    border: 1px solid var(--hairline); color: var(--fg); transition: background .15s ease;
  }
  a.btn:hover { background: var(--surface); }
  a.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  a.btn.primary:hover { filter: brightness(1.08); }
</style>`;

/** The new-tab start page — a single quiet greeting (pane §14 "New tab / start"). */
export function renderNewTab(): string {
  return `${PAGE_HEAD}<title>New Tab</title></head><body>
  <main class="wrap">
    <div class="greeting">marudesk</div>
    <div class="sub">Search or enter an address in the bar above.</div>
  </main>
</body></html>`;
}

/**
 * The custom load-error page. `searchHref` is the (already built) search URL for
 * the "Search instead" action, computed by the caller from the user's engine.
 */
export function renderErrorPage(info: InternalErrorInfo, searchHref: string): string {
  const canRetry = /^https?:\/\//i.test(info.failedUrl);
  const retry = canRetry
    ? `<a class="btn primary" href="${escapeHtml(info.failedUrl)}">Retry</a>`
    : '';
  const desc = info.description
    ? `<div class="desc mono">${escapeHtml(info.description)}</div>`
    : '';
  const urlRow = info.failedUrl
    ? `<div class="url mono">${escapeHtml(info.failedUrl)}</div>`
    : '';
  return `${PAGE_HEAD}<title>Can’t load page</title></head><body>
  <main class="wrap">
    <h1>${escapeHtml(errorHeadline(info))}</h1>
    ${urlRow}
    ${desc}
    <div class="actions">
      ${retry}
      <a class="btn" href="${escapeHtml(searchHref)}">Search instead</a>
    </div>
  </main>
</body></html>`;
}

/** A 404 for an unknown `maru://<page>`. */
export function renderNotFound(page: string): string {
  return `${PAGE_HEAD}<title>Not found</title></head><body>
  <main class="wrap">
    <h1>No such page</h1>
    <div class="url mono">${escapeHtml(`${INTERNAL_SCHEME}://${page}`)}</div>
  </main>
</body></html>`;
}
