import https from 'node:https';
import http from 'node:http';
import { scrubText } from '../../../shared/scrub';
import { clampNumber } from '../../../shared/coerce';
import { clipText } from '../../../shared/text-clip';
import type { McpTool, ToolResult } from './types';

/**
 * `fetch_url` — read a public web page (or text/JSON resource) as plain text. This
 * complements {@link WEB_SEARCH_TOOL}: web_search returns only titles/snippets, so
 * the agent had no way to actually READ a result without an open browser tab. This
 * tool fetches one URL (following redirects, bounded in time + bytes) and reduces an
 * HTML body to readable text; text/JSON bodies pass through verbatim (clipped).
 *
 * Safety: it's `gated` (the user approves each call). As defense-in-depth against
 * SSRF — an agent reaching the user's own loopback/LAN services — we refuse non
 * http(s) URLs and any host that is a loopback / private / link-local address (and
 * re-check on every redirect hop). Output is scrubbed at egress and the response
 * size is capped before we ever decode it.
 */

const MAX_CHARS = 20_000;
const MAX_RESPONSE_BYTES = 2_000_000; // 2 MB hard cap before decode
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;

const strProp = (desc: string) => ({ type: 'string', description: desc });

class FetchUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchUrlError';
  }
}

/** The fetched response, reduced to the fields we map. */
export type FetchUrlResult = {
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
};

type FetchUrlTransport = (url: URL, signal: AbortSignal) => Promise<FetchUrlResult>;

let fetchUrlTransportForTests: FetchUrlTransport | null = null;

/** Inject a deterministic transport (harness only); pass null to restore the real one. */
export function setFetchUrlTransportForTests(transport: FetchUrlTransport | null): void {
  fetchUrlTransportForTests = transport;
}

/**
 * Whether a hostname is a loopback / private / link-local address we refuse to fetch
 * (SSRF guard). Literal hostnames only — we don't resolve DNS here; the per-call
 * approval gate is the primary control and this blocks the obvious internal targets.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10).
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  // IPv4 dotted-quad ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 0 || a === 10) return true; // loopback / "this" / private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
  }
  return false;
}

/** Clamp a requested max-chars to a sane bound; default {@link MAX_CHARS}. */
function clampMaxChars(value: unknown): number {
  return clampNumber(value, MAX_CHARS, 500, MAX_CHARS);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Decode the handful of HTML entities (named + decimal/hex numeric) that survive
 *  tag-stripping. Exported + reused by web-search.ts's snippet cleaner. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => codePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, code) => codePoint(Number(code), m));
}

/** A numeric character reference → its code point, or the original text if invalid. */
function codePoint(n: number, original: string): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : original;
}

/**
 * Reduce an HTML document to readable text: drop script/style/head noise, turn block
 * boundaries into newlines, strip the remaining tags, decode entities, and collapse
 * runaway whitespace. Best-effort (no DOM in the main process) — good enough for the
 * model to read an article or doc page.
 */
export function htmlToText(html: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : '';
  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|ul|ol|tr|table|h[1-6]|header|footer|nav|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ');
  body = stripTags(body);
  body = decodeEntities(body)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title && !body.startsWith(title) ? `${title}\n\n${body}` : body;
}

/** Replace every HTML tag with a space (collapse the spaces afterwards). Exported
 *  + reused by web-search.ts. */
export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

async function fetchUrl(
  input: Record<string, unknown>,
  ctx: { readonly signal: AbortSignal },
): Promise<ToolResult> {
  const raw = typeof input.url === 'string' ? input.url.trim() : '';
  if (!raw) throw new Error('fetch_url requires "url"');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('fetch_url requires a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { summary: 'fetch_url', text: 'fetch_url only supports http(s) URLs.', isError: true };
  }
  if (isBlockedHost(url.hostname)) {
    return {
      summary: `fetch_url ${url.hostname}`,
      text: 'Refused: that host is a loopback / private / link-local address.',
      isError: true,
    };
  }
  const maxChars = clampMaxChars(input.maxChars);
  try {
    const res = await (fetchUrlTransportForTests ?? httpGet)(url, ctx.signal);
    const ct = res.contentType.toLowerCase();
    const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
    const isTextual =
      isHtml ||
      ct.startsWith('text/') ||
      ct.includes('json') ||
      ct.includes('xml') ||
      ct.includes('javascript') ||
      ct === ''; // some servers omit a content-type
    let text: string;
    if (!isTextual) {
      text = `[non-text content omitted: ${res.contentType || 'unknown type'}]`;
    } else {
      text = isHtml ? htmlToText(res.body) : res.body.trim();
      if (!text) text = '(empty document)';
    }
    const host = scrubText(url.hostname);
    return {
      summary: `fetch_url ${host}`,
      text: clipText(scrubText(text), maxChars),
    };
  } catch (err) {
    return {
      summary: `fetch_url ${scrubText(url.hostname)} failed`,
      text: err instanceof FetchUrlError ? err.message : 'Failed to fetch the URL.',
      isError: true,
    };
  }
}

/** Real fetch over node http(s) with redirect following + a byte/time cap. */
function httpGet(url: URL, signal: AbortSignal, redirectsLeft = MAX_REDIRECTS): Promise<FetchUrlResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let total = 0;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const client = url.protocol === 'http:' ? http : https;
    const req = client.get(
      url,
      { headers: { 'User-Agent': 'marudesk-agent/0.1', Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8' }, signal },
      (res) => {
        const status = res.statusCode ?? 0;
        // Follow redirects (re-checking the SSRF guard on each hop).
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          if (redirectsLeft <= 0) return fail(new FetchUrlError('Too many redirects.'));
          let next: URL;
          try {
            next = new URL(res.headers.location, url);
          } catch {
            return fail(new FetchUrlError('Invalid redirect location.'));
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return fail(new FetchUrlError('Redirect to a non-http(s) URL.'));
          }
          if (isBlockedHost(next.hostname)) {
            return fail(new FetchUrlError('Redirect to a blocked host.'));
          }
          if (settled) return;
          settled = true;
          httpGet(next, signal, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return fail(new FetchUrlError(`Server returned HTTP ${status}.`));
        }
        const contentType = String(res.headers['content-type'] ?? '');
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            fail(new FetchUrlError('Response was too large.'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8'), finalUrl: url.href });
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      fail(new FetchUrlError('Request timed out.'));
      req.destroy();
    });
    req.on('error', () => fail(new FetchUrlError('Failed to fetch the URL.')));
  });
}

export const FETCH_URL_TOOL: McpTool = {
  name: 'fetch_url',
  description:
    'Fetch one public web page or text/JSON resource by URL and return its readable text. Use after web_search to actually read a result, or to read a known URL. HTML is reduced to text; binary content is not returned.',
  inputSchema: {
    type: 'object',
    properties: {
      url: strProp('The http(s) URL to fetch.'),
      maxChars: { type: 'number', description: `Max characters to return, up to ${MAX_CHARS}. Defaults to ${MAX_CHARS}.` },
    },
    required: ['url'],
    additionalProperties: false,
  },
  group: 'web',
  gated: true,
  exec: fetchUrl,
};
