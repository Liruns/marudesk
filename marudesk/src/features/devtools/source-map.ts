/**
 * Hand-rolled, dependency-free source map support for the Sources panel (P5b).
 * Implements exactly the slice the panel needs from the v3 spec: a base64-VLQ
 * `mappings` decoder plus generated↔original position lookups over the decoded
 * entries, with the `sources` / `sourcesContent` arrays. Pure module — no CDP
 * and no store access, so it unit-tests cheaply (see source-map.test.ts).
 *
 * Robustness contract: every function is total over garbage input — a malformed
 * map yields `null` (never a throw), so the callers' generated-source path can
 * always silently fall back.
 */

/** One decoded mapping segment that carries source info (absolute values). */
export type SourceMapMapping = {
  genLine: number;
  genCol: number;
  srcIndex: number;
  origLine: number;
  origCol: number;
};

/** A parsed v3 source map (the subset we consume). */
export type ParsedSourceMap = {
  sources: string[];
  /** Index-aligned with `sources`; null when the map didn't embed the text. */
  sourcesContent: (string | null)[];
  sourceRoot: string;
  /** Mappings with source info, sorted by (genLine, genCol). */
  mappings: SourceMapMapping[];
};

/** A script's resolved map + display URLs, as cached in the devtools store. */
export type ScriptSourceMap = {
  map: ParsedSourceMap;
  /** `sources` resolved against sourceRoot + the script URL, for display/keys. */
  sourceUrls: string[];
};

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHAR_TO_INT = new Map<string, number>(
  [...BASE64_CHARS].map((c, i) => [c, i]),
);

// A mappings string can't be unbounded — a corrupt/hostile map must not melt
// the renderer. ~64M chars (≫ any real map we'd meet) is the hard stop.
const MAX_MAPPINGS_CHARS = 64_000_000;

/**
 * Decode a v3 `mappings` string into absolute mapping entries. Segments without
 * source info (1-field) only advance the generated column and are dropped.
 * Returns null on any malformed input.
 */
function parseMappings(mappings: string): SourceMapMapping[] | null {
  if (mappings.length > MAX_MAPPINGS_CHARS) return null;
  const out: SourceMapMapping[] = [];
  let genLine = 0;
  let genCol = 0;
  let srcIndex = 0;
  let origLine = 0;
  let origCol = 0;
  let i = 0;
  const n = mappings.length;
  while (i < n) {
    const ch = mappings[i];
    if (ch === ';') {
      genLine++;
      genCol = 0;
      i++;
      continue;
    }
    if (ch === ',') {
      i++;
      continue;
    }
    // One segment: 1, 4, or 5 VLQ values.
    const fields: number[] = [];
    for (;;) {
      // One VLQ value: little-endian base-32 digits, bit 5 = continuation,
      // bit 0 of the assembled number = sign.
      let result = 0;
      let shift = 0;
      let cont = true;
      while (cont) {
        if (i >= n) return null;
        const digit = CHAR_TO_INT.get(mappings[i]);
        if (digit === undefined) return null;
        i++;
        cont = (digit & 32) !== 0;
        result += (digit & 31) * 2 ** shift;
        shift += 5;
        if (shift > 35) return null; // > 32-bit value — corrupt
      }
      fields.push(result % 2 === 1 ? -((result - 1) / 2) : result / 2);
      if (fields.length > 5) return null;
      const next = i < n ? mappings[i] : '';
      if (next === ',' || next === ';' || next === '') break;
    }
    genCol += fields[0];
    if (fields.length === 1) continue; // generated-only segment
    if (fields.length !== 4 && fields.length !== 5) return null;
    srcIndex += fields[1];
    origLine += fields[2];
    origCol += fields[3];
    if (genCol < 0 || srcIndex < 0 || origLine < 0 || origCol < 0) return null;
    out.push({ genLine, genCol, srcIndex, origLine, origCol });
  }
  // Well-formed maps are already in generated order; sort defensively so the
  // binary searches below stay correct on sloppy generators.
  out.sort((a, b) => a.genLine - b.genLine || a.genCol - b.genCol);
  return out;
}

/**
 * Parse a decoded source-map JSON value into the subset we use. Returns null
 * for anything that isn't a plain v3 map (indexed `sections` maps included —
 * they're rare from dev servers and not worth the surface).
 */
export function parseSourceMap(raw: unknown): ParsedSourceMap | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m.version !== 3) return null;
  if ('sections' in m) return null;
  if (!Array.isArray(m.sources) || typeof m.mappings !== 'string') return null;
  const sources = m.sources.map((s) => (typeof s === 'string' ? s : ''));
  const rawContent: unknown[] = Array.isArray(m.sourcesContent) ? m.sourcesContent : [];
  const sourcesContent = sources.map((_, i) => {
    const c = rawContent[i];
    return typeof c === 'string' ? c : null;
  });
  const mappings = parseMappings(m.mappings);
  if (mappings === null) return null;
  const sourceRoot = typeof m.sourceRoot === 'string' ? m.sourceRoot : '';
  return { sources, sourcesContent, sourceRoot, mappings };
}

/**
 * Generated (line, column) → original position: the nearest mapping at-or-before
 * the column ON THE SAME generated line (a paused location/frame always has a
 * mapping on its line when the map covers it). Null when the line is unmapped.
 */
export function originalPositionFor(
  map: ParsedSourceMap,
  line: number,
  column: number,
): { srcIndex: number; line: number; column: number } | null {
  const arr = map.mappings;
  let lo = 0;
  let hi = arr.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = arr[mid];
    if (e.genLine < line || (e.genLine === line && e.genCol <= column)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return null;
  const e = arr[best];
  if (e.genLine !== line) return null;
  return { srcIndex: e.srcIndex, line: e.origLine, column: e.origCol };
}

// Per-source mappings sorted by original position, built lazily per map (the
// WeakMap keeps this module pure/stateless from the caller's point of view).
const bySourceCache = new WeakMap<ParsedSourceMap, Map<number, SourceMapMapping[]>>();

function mappingsForSource(map: ParsedSourceMap, srcIndex: number): SourceMapMapping[] {
  let cache = bySourceCache.get(map);
  if (!cache) {
    cache = new Map();
    bySourceCache.set(map, cache);
  }
  let arr = cache.get(srcIndex);
  if (!arr) {
    arr = map.mappings
      .filter((e) => e.srcIndex === srcIndex)
      .sort(
        (a, b) =>
          a.origLine - b.origLine ||
          a.origCol - b.origCol ||
          a.genLine - b.genLine ||
          a.genCol - b.genCol,
      );
    cache.set(srcIndex, arr);
  }
  return arr;
}

/**
 * Original (source, line) → generated position: the first mapping of that
 * source at-or-after the original line (so a breakpoint on a blank/comment
 * line slides down to the next mapped statement, like DevTools). Null when the
 * source has no mapping at or after the line.
 */
export function generatedPositionFor(
  map: ParsedSourceMap,
  srcIndex: number,
  line: number,
): { line: number; column: number } | null {
  const arr = mappingsForSource(map, srcIndex);
  let lo = 0;
  let hi = arr.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].origLine >= line) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (best < 0) return null;
  const e = arr[best];
  return { line: e.genLine, column: e.genCol };
}

/** The source index a plain "show original" toggle should default to. */
export function defaultSourceIndex(map: ParsedSourceMap): number {
  return map.mappings.length > 0 ? map.mappings[0].srcIndex : 0;
}

/** True for absolute URLs (any scheme — http:, webpack:, file:, …). */
function hasScheme(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
}

/**
 * Decode an inline `data:` sourceMappingURL into its JSON text. Returns null
 * for non-data URLs or undecodable payloads.
 */
export function decodeSourceMapDataUrl(url: string): string | null {
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  try {
    if (/(^|;)base64$/.test(meta)) return decodeBase64Text(payload);
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/** Base64 → UTF-8 text (also used to decode base64 `IO.read` chunks). */
export function decodeBase64Text(b64: string): string | null {
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Resolve a (possibly relative) URL against a base; null when unresolvable. */
export function resolveUrl(url: string, baseUrl: string): string | null {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    try {
      return new URL(url).toString();
    } catch {
      return null;
    }
  }
}

/**
 * The display/identity URL of one `sources` entry: sourceRoot-prefixed per the
 * spec, then resolved against the script URL when still relative. Absolute
 * entries (including webpack:// pseudo-URLs) pass through untouched. Always
 * returns a string — resolution failures fall back to the joined raw value.
 */
export function resolveSourceUrl(
  sourceRoot: string,
  source: string,
  scriptUrl: string,
): string {
  if (hasScheme(source)) return source;
  const joined = sourceRoot
    ? sourceRoot.endsWith('/')
      ? sourceRoot + source
      : `${sourceRoot}/${source}`
    : source;
  if (hasScheme(joined)) return joined;
  return resolveUrl(joined, scriptUrl) ?? joined;
}
