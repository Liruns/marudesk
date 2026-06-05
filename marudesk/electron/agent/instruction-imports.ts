import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * `@`-import expansion for instruction files (Claude Code CLAUDE.md `@import`
 * parity). An instruction file can pull in another file's contents with an
 * `@relative/path` token (e.g. our own `CLAUDE.md` is just `@AGENTS.md`); we
 * expand those inline, recursively, before the content is folded into the
 * prompt.
 *
 * Deliberately TIGHTER than Claude Code on the trust boundary: imports must
 * resolve to an existing file INSIDE the workspace root. A token that escapes
 * the root (`@~/...`, `@../outside`) or doesn't resolve to a file is left as
 * literal text — so a cloned repo can't use an import to pull arbitrary host
 * files (e.g. `~/.ssh/...`) into the model's context, and ordinary `@mentions`
 * (emails, npm scopes) are never clobbered because they don't resolve to a file.
 *
 * Bounded: max {@link MAX_IMPORT_DEPTH} hops, a per-file byte cap, and a
 * visited-set so a cycle (`a → b → a`) terminates. Dependency-light (node fs +
 * path only) so it's harness-testable.
 */

const MAX_IMPORT_DEPTH = 4;
const MAX_IMPORT_BYTES = 16_000;
/** `@` preceded by start-of-line or whitespace, then a non-space path token. */
const IMPORT_RE = /(^|\s)@([^\s@]+)/g;

function isInsideRoot(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Expand `@import` tokens in `content`. `fileAbs` is the absolute path of the
 * file the content came from (imports resolve relative to its directory);
 * `wsRoot` bounds resolution to the workspace. Returns the content with every
 * resolvable in-root import inlined (recursively); unresolvable tokens are kept
 * verbatim.
 */
export async function expandInstructionImports(
  content: string,
  fileAbs: string,
  wsRoot: string,
): Promise<string> {
  const root = path.resolve(wsRoot);
  return expand(content, path.resolve(fileAbs), root, 1, new Set([path.resolve(fileAbs)]));
}

async function expand(
  content: string,
  fileAbs: string,
  root: string,
  depth: number,
  seen: Set<string>,
): Promise<string> {
  if (depth > MAX_IMPORT_DEPTH) return content;

  // Collect matches first (regex replace can't await), then rebuild the string.
  const matches = [...content.matchAll(IMPORT_RE)];
  if (matches.length === 0) return content;

  let out = '';
  let cursor = 0;
  for (const m of matches) {
    const [whole, lead, token] = m;
    const start = m.index ?? 0;
    out += content.slice(cursor, start);
    cursor = start + whole.length;

    const resolved = resolveImport(token, fileAbs, root);
    if (!resolved || seen.has(resolved)) {
      // Unresolvable, out-of-root, or a cycle — keep the literal token.
      out += whole;
      continue;
    }
    let imported: string;
    try {
      imported = (await fs.readFile(resolved, 'utf8')).slice(0, MAX_IMPORT_BYTES);
    } catch {
      out += whole; // not a readable file — leave as text
      continue;
    }
    seen.add(resolved);
    const nested = await expand(imported, resolved, root, depth + 1, seen);
    // Preserve the captured leading whitespace so surrounding prose stays intact.
    out += `${lead}${nested.trim()}`;
  }
  out += content.slice(cursor);
  return out;
}

/** Resolve an import token to an absolute in-root file path, or null. */
function resolveImport(token: string, fileAbs: string, root: string): string | null {
  // Reject home/absolute escapes outright (trust boundary — see module docs).
  if (token.startsWith('~') || path.isAbsolute(token)) return null;
  const abs = path.resolve(path.dirname(fileAbs), token);
  return isInsideRoot(root, abs) ? abs : null;
}
