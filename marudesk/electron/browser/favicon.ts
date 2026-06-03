import { net } from 'electron';
import { pushState, type TabRecord } from './state';

/**
 * Favicon fetcher for the embedded browser tabs.
 *
 * Why this exists rather than handing the raw favicon URL to the renderer: the
 * host renderer runs under a strict `img-src 'self' data: blob:` CSP (main.ts),
 * so an `<img src="https://site/favicon.ico">` in the React tab strip would be
 * blocked. Instead we fetch the icon main-side (not subject to renderer CSP),
 * inline it as a `data:` URL, and stash it on the tab record so the next
 * `pushState` carries it to the strip. The fetch uses the default session — not
 * the web tabs' partition — so icon requests can't smuggle page cookies out.
 *
 * Package leaf-consumer: imports only ./state, never its siblings — no cycle.
 */

// Cap on a fetched icon's bytes. Favicons are tiny (a few KB); this bounds a
// hostile/oversized icon from bloating the tabs snapshot, which is re-sent on
// every pushState. A rejected icon just falls back to the globe glyph.
const MAX_FAVICON_BYTES = 128 * 1024;

// favicon URL → data URL (or null = known-bad, don't refetch). Favicons repeat
// across a site's pages and tabs, so each distinct URL is fetched once/session.
// Bounded: cleared wholesale when full (entries simply re-fetch) so a very long
// session across many sites can't grow it without limit.
const cache = new Map<string, string | null>();
const MAX_CACHE_ENTRIES = 512;

/**
 * Handle a `page-favicon-updated` event: pick the page's best declared icon,
 * resolve it to a data URL (cached), and push it to the renderer once ready.
 */
export function updateFavicon(rec: TabRecord, favicons: string[]): void {
  // Electron lists the page's declared icons best-first. A `data:` icon is
  // already inline-renderable; otherwise take the first http(s) URL.
  const inline = favicons.find((u) => u.startsWith('data:'));
  if (inline) {
    adopt(rec, inline, inline);
    return;
  }
  const url = favicons.find((u) => /^https?:\/\//i.test(u));
  if (!url) return;

  // Record the requested source *now*, before the async fetch, so that:
  //  - a newer favicon event (or a clearFavicon on navigation) moves faviconUrl
  //    on, and this fetch's late resolution self-cancels (guard below);
  //  - the in-flight intent is visible to those events.
  rec.faviconUrl = url;

  const cached = cache.get(url);
  if (cached !== undefined) {
    if (cached) adopt(rec, url, cached);
    return;
  }
  void fetchAsDataUrl(url).then((dataUrl) => {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(url, dataUrl);
    // Only adopt if the tab still wants this exact source (no newer favicon
    // event and no navigation cleared it while we were fetching).
    if (dataUrl && rec.faviconUrl === url) adopt(rec, url, dataUrl);
  });
}

/** Drop the tab's favicon (top-level navigation to a new document). */
export function clearFavicon(rec: TabRecord): void {
  if (rec.favicon === undefined && rec.faviconUrl === undefined) return;
  rec.favicon = undefined;
  rec.faviconUrl = undefined;
}

function adopt(rec: TabRecord, sourceUrl: string, dataUrl: string): void {
  rec.faviconUrl = sourceUrl;
  if (rec.favicon === dataUrl) return; // already current — skip the IPC churn
  rec.favicon = dataUrl;
  pushState();
}

// A favicon is never worth blocking on: a slow or stalled host should fall back
// to the globe glyph rather than leave the fetch — and the cache slot it will
// fill — pending for the rest of the session. Abort the request past this point.
const FETCH_TIMEOUT_MS = 5000;

async function fetchAsDataUrl(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || 'image/x-icon')
      .split(';')[0]
      .trim();
    if (!/^image\//i.test(type)) return null;
    // Reject an oversized icon from its declared length before buffering the
    // body, so a fast host can't stream megabytes into memory inside the
    // timeout window. The post-decode check still covers a missing/lying header.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FAVICON_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_FAVICON_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
