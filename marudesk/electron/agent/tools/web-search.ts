import https from 'node:https';
import { z } from 'zod';
import { scrubText } from '../../../shared/scrub';
import type { McpTool, ToolResult } from './types';

const MAX_RESULTS = 6;
const MAX_TEXT = 8_000;
const MAX_QUERY_CHARS = 300;
const MAX_RESPONSE_BYTES = 256_000;
const REQUEST_TIMEOUT_MS = 8_000;

export const WEB_SEARCH_MAX_RESPONSE_BYTES_FOR_TESTS = MAX_RESPONSE_BYTES;

const strProp = (desc: string) => ({ type: 'string', description: desc });

const DuckResponse = z.object({
  AbstractText: z.string().optional(),
  AbstractURL: z.string().optional(),
  Heading: z.string().optional(),
  RelatedTopics: z.array(z.unknown()).optional(),
});

const Topic = z.object({
  Text: z.string().optional(),
  FirstURL: z.string().optional(),
  Topics: z.array(z.unknown()).optional(),
});

type WebSearchTransport = (url: URL, signal: AbortSignal) => Promise<unknown>;

type SearchHit = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

class WebSearchProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchProviderError';
  }
}

class BoundedJsonAccumulator {
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.totalBytes > MAX_RESPONSE_BYTES) {
      throw new WebSearchProviderError('Search provider response was too large.');
    }
    this.chunks.push(chunk);
  }

  finish(statusCode: number): unknown {
    if (statusCode < 200 || statusCode >= 300) {
      throw new WebSearchProviderError(`Search provider returned HTTP ${statusCode}.`);
    }
    try {
      return JSON.parse(Buffer.concat(this.chunks).toString('utf8'));
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new WebSearchProviderError('Search provider returned invalid JSON.');
      }
      throw err;
    }
  }
}

let webSearchTransportForTests: WebSearchTransport | null = null;

export function setWebSearchTransportForTests(transport: WebSearchTransport | null): void {
  webSearchTransportForTests = transport;
}

type WebSearchHtmlTransport = (url: URL, signal: AbortSignal) => Promise<string>;

let webSearchHtmlTransportForTests: WebSearchHtmlTransport | null = null;

/** Inject the HTML-fallback transport (harness only); pass null to restore the real one. */
export function setWebSearchHtmlTransportForTests(transport: WebSearchHtmlTransport | null): void {
  webSearchHtmlTransportForTests = transport;
}

async function webSearch(input: Record<string, unknown>, ctx: { readonly signal: AbortSignal }): Promise<ToolResult> {
  const rawQuery = typeof input.query === 'string' ? input.query.trim() : '';
  const query = rawQuery.length > MAX_QUERY_CHARS ? rawQuery.slice(0, MAX_QUERY_CHARS) : rawQuery;
  if (!query) throw new Error('web_search requires "query"');
  const maxResults =
    typeof input.maxResults === 'number'
      ? Math.max(1, Math.min(Math.floor(input.maxResults), MAX_RESULTS))
      : MAX_RESULTS;
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  try {
    const payload = await (webSearchTransportForTests ?? getJson)(url, ctx.signal);
    const parsed = DuckResponse.parse(payload);
    let hits = resultHits(parsed).slice(0, maxResults);
    // The Instant Answer API only covers entities/disambiguation, so most ordinary
    // queries return nothing. Fall back to DuckDuckGo's HTML results endpoint for
    // real web results. A fallback failure is non-fatal — we just report none.
    if (hits.length === 0) {
      const htmlUrl = new URL('https://html.duckduckgo.com/html/');
      htmlUrl.searchParams.set('q', query);
      try {
        const html = await (webSearchHtmlTransportForTests ?? getText)(htmlUrl, ctx.signal);
        hits = parseHtmlHits(html).slice(0, maxResults);
      } catch {
        // Keep the empty result — the IA call already succeeded.
      }
    }
    const displayQuery = scrubText(query);
    return {
      summary: `web_search "${displayQuery}"`,
      text: hits.length > 0 ? clip(hits.map(formatHit).join('\n\n')) : 'No web search results found.',
    };
  } catch (err) {
    if (err instanceof Error) {
      return { summary: `web_search "${scrubText(query)}" failed`, text: safeFailureText(err), isError: true };
    }
    throw err;
  }
}

function safeFailureText(err: Error): string {
  if (err instanceof WebSearchProviderError) return err.message;
  return 'Search provider request failed.';
}

function resultHits(payload: z.infer<typeof DuckResponse>): SearchHit[] {
  const hits: SearchHit[] = [];
  if (payload.AbstractText && payload.AbstractURL) {
    hits.push({ title: payload.Heading || payload.AbstractURL, url: payload.AbstractURL, snippet: payload.AbstractText });
  }
  for (const topic of payload.RelatedTopics ?? []) collectTopic(topic, hits);
  return dedupeHits(hits);
}

function collectTopic(value: unknown, hits: SearchHit[]): void {
  const parsed = Topic.safeParse(value);
  if (!parsed.success) return;
  if (parsed.data.Topics) {
    for (const child of parsed.data.Topics) collectTopic(child, hits);
    return;
  }
  if (!parsed.data.Text || !parsed.data.FirstURL) return;
  hits.push({
    title: parsed.data.Text.split(' - ')[0] || parsed.data.FirstURL,
    url: parsed.data.FirstURL,
    snippet: parsed.data.Text,
  });
}

function dedupeHits(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push(hit);
  }
  return out;
}

function formatHit(hit: SearchHit): string {
  return `- ${scrubText(hit.title)}\n  URL: ${scrubText(hit.url)}\n  ${scrubText(hit.snippet)}`;
}

/**
 * Parse the DuckDuckGo HTML results page (the `html.duckduckgo.com/html/` endpoint)
 * into hits. Result links carry the real target in a `uddg` redirect param, which we
 * decode. Best-effort regex parsing (no DOM in the main process); title↔snippet are
 * paired by document order, which is how the page lays them out.
 */
function parseHtmlHits(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkRe = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(htmlText(sm[1]));
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html))) {
    const target = decodeDuckUrl(m[1]);
    const title = htmlText(m[2]);
    const snippet = snippets[i] ?? '';
    i += 1;
    if (target && title) hits.push({ title, url: target, snippet });
  }
  return dedupeHits(hits);
}

/** Pull the real target URL out of a DuckDuckGo `/l/?uddg=…` redirect href. */
function decodeDuckUrl(href: string): string {
  const abs = href.startsWith('//') ? `https:${href}` : href;
  try {
    const u = new URL(abs, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

/** Strip tags + decode the common entities from a snippet of result HTML. */
function htmlText(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}\n[clipped ${text.length - MAX_TEXT} chars]`;
}

function getJson(url: URL, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const accumulator = new BoundedJsonAccumulator();
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = https.get(url, { headers: { 'User-Agent': 'marudesk-agent/0.1' }, signal }, (res) => {
      res.on('data', (chunk: Buffer) => {
        try {
          accumulator.push(chunk);
        } catch (err) {
          if (err instanceof Error) fail(err);
          else fail(new WebSearchProviderError('Search provider request failed.'));
          req.destroy();
        }
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          resolve(accumulator.finish(res.statusCode ?? 0));
        } catch (err) {
          if (err instanceof Error) reject(err);
          else reject(new WebSearchProviderError('Search provider request failed.'));
        }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      fail(new WebSearchProviderError('Web search timed out.'));
      req.destroy();
    });
    req.on('error', () => fail(new WebSearchProviderError('Search provider request failed.')));
  });
}

/** Fetch a text body (the HTML results page) with the same time + byte caps as getJson. */
function getText(url: URL, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let total = 0;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = https.get(url, { headers: { 'User-Agent': 'marudesk-agent/0.1' }, signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        return fail(new WebSearchProviderError(`Search provider returned HTTP ${status}.`));
      }
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          fail(new WebSearchProviderError('Search provider response was too large.'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      fail(new WebSearchProviderError('Web search timed out.'));
      req.destroy();
    });
    req.on('error', () => fail(new WebSearchProviderError('Search provider request failed.')));
  });
}

export function parseBoundedWebSearchJsonForTests(
  chunks: readonly Buffer[],
  statusCode = 200,
): unknown {
  const accumulator = new BoundedJsonAccumulator();
  for (const chunk of chunks) accumulator.push(chunk);
  return accumulator.finish(statusCode);
}

export const WEB_SEARCH_TOOL: McpTool = {
  name: 'web_search',
  description:
    'Search the public web for current information. Use this when the answer may depend on recent or external facts. Returns a short list of source URLs and snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      query: strProp('Search query.'),
      maxResults: { type: 'number', description: `Maximum results, 1-${MAX_RESULTS}. Defaults to ${MAX_RESULTS}.` },
    },
    required: ['query'],
    additionalProperties: false,
  },
  group: 'web',
  gated: true,
  exec: webSearch,
};
