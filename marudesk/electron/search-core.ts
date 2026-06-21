import type {
  SearchMatchRange,
  SearchOptions,
} from '../shared/search';
import type { WorkspaceId } from '../shared/workspace';

/**
 * Pure, electron-free helpers behind the workspace content search. Kept in a
 * standalone module (only node:Buffer + shared types) so the glob filter, line
 * matcher, and preview/range builders can be unit-tested via the search harness
 * without booting Electron.
 */

/**
 * Pick the filesystem root a content search should run against, given the two
 * registry lookups (injected so this stays electron-free + testable):
 *   - `activeRoot()` — the global active workspace's root (throws "no workspace
 *     is open" when none), used when no `workspaceId` is threaded.
 *   - `rootFor(id)` — that workspace's active root, or null when it's gone.
 *
 * A Search instrument bound to a non-active workspace threads its `workspaceId`
 * so the result list scopes to the SAME root its opened file refs resolve
 * against; omitting it preserves the active-workspace path byte-for-byte.
 */
export function resolveSearchRoot(
  workspaceId: WorkspaceId | undefined,
  activeRoot: () => string,
  rootFor: (id: WorkspaceId) => string | null,
): string {
  if (workspaceId === undefined) return activeRoot();
  const root = rootFor(workspaceId);
  if (root === null) throw new Error(`workspace not found: ${workspaceId}`);
  return root;
}

/** Escape a string for literal use inside a RegExp (internal helper). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split a "files to include/exclude" field into individual globs. Users type
 * them comma- or newline-separated (VSCode style); blanks are dropped.
 */
export function parseGlobs(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

/**
 * Convert a single glob to a RegExp anchored to a workspace-relative POSIX
 * path. Mirrors the ripgrep `--glob` semantics we lean on when ripgrep is
 * present: a pattern with no `/` matches a file's basename at any depth, while
 * one containing `/` is anchored to the root. Supports `*`, `**`, `?`, and
 * `{a,b}` alternation.
 */
export function globToRegExp(glob: string): RegExp {
  const anchored = glob.includes('/');
  // A trailing-slash pattern (e.g. `dist/`) targets a directory subtree.
  const dirOnly = glob.endsWith('/');
  const body = dirOnly ? glob.slice(0, -1) : glob;

  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*') {
      if (body[i + 1] === '*') {
        // `**` spans path separators; consume an optional following slash so
        // `src/**` matches `src/a/b` and `src` itself isn't required to have a
        // trailing segment.
        i++;
        if (body[i + 1] === '/') i++;
        out += '.*';
      } else {
        // A single `*` matches within a path segment (no `/`).
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      out += '(?:';
    } else if (c === '}') {
      out += ')';
    } else if (c === ',') {
      out += '|';
    } else {
      out += escapeRegExp(c);
    }
  }

  if (dirOnly) out += '(?:/.*)?';
  const pattern = anchored ? `^${out}$` : `(?:^|.*/)${out}$`;
  return new RegExp(pattern);
}

/** A compiled include/exclude predicate over workspace-relative POSIX paths. */
export type PathFilter = (relPath: string) => boolean;

/**
 * Build a predicate from the include/exclude glob fields. With no includes,
 * everything is in scope; excludes always win. Used by the Node fallback walk
 * (ripgrep applies the same globs itself via `--glob`).
 */
export function compilePathFilter(
  includes: string[],
  excludes: string[],
): PathFilter {
  const inc = includes.map(globToRegExp);
  const exc = excludes.map(globToRegExp);
  return (rel: string): boolean => {
    if (exc.some((re) => re.test(rel))) return false;
    if (inc.length > 0 && !inc.some((re) => re.test(rel))) return false;
    return true;
  };
}

/**
 * Build a per-line matcher returning every match span (0-based char offsets)
 * on the line — used by the Node fallback to drive both the column and the
 * highlight ranges.
 */
export function makeLineMatcher(
  query: string,
  opts: SearchOptions,
): (line: string) => SearchMatchRange[] {
  if (opts.regex || opts.wholeWord) {
    const bodyText = opts.regex ? query : escapeRegExp(query);
    const pattern = opts.wholeWord ? `\\b(?:${bodyText})\\b` : bodyText;
    const flags = opts.caseSensitive ? 'g' : 'gi';
    const re = new RegExp(pattern, flags);
    return (line: string): SearchMatchRange[] => {
      const ranges: SearchMatchRange[] = [];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const end = m.index + m[0].length;
        ranges.push({ start: m.index, end });
        // Guard against zero-width matches (e.g. `a*`) looping forever.
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      return ranges;
    };
  }
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  return (line: string): SearchMatchRange[] => {
    const hay = opts.caseSensitive ? line : line.toLowerCase();
    const ranges: SearchMatchRange[] = [];
    let from = 0;
    for (;;) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      ranges.push({ start: i, end: i + needle.length });
      from = i + Math.max(1, needle.length);
    }
    return ranges;
  };
}

/**
 * Convert a byte offset within a UTF-8 line to a char (code-unit) index, so
 * ripgrep's byte-based submatch offsets line up with the JS string we slice for
 * the preview. Cheap for the common all-ASCII case (byte length === char
 * length).
 */
export function byteToCharIndex(line: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const bytes = Buffer.from(line, 'utf8');
  if (byteOffset >= bytes.length) return line.length;
  return bytes.subarray(0, byteOffset).toString('utf8').length;
}

/**
 * Left-trim a matched line for the preview and re-base + clamp its ranges to the
 * trimmed, length-capped string. Ranges shifted before 0 or past the cap are
 * dropped/clamped so the panel can highlight without re-trimming.
 */
export function buildPreview(
  lineText: string,
  ranges: SearchMatchRange[],
  maxPreview: number,
): { preview: string; ranges: SearchMatchRange[] } {
  const lead = lineText.length - lineText.trimStart().length;
  const preview = lineText.slice(lead, lead + maxPreview);
  const cap = preview.length;
  const out: SearchMatchRange[] = [];
  for (const r of ranges) {
    const start = Math.max(0, r.start - lead);
    const end = Math.min(cap, r.end - lead);
    if (end > start) out.push({ start, end });
  }
  return { preview, ranges: out };
}
