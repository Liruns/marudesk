/**
 * Pure newString normalization for the verbatim (non-anchored) edit path, ported
 * from oh-my-openagent's `edit-text-normalization.ts` (read-view prefix strip) and
 * `autocorrect-replacement-lines.ts` (collapsed-multiline / wrapped-single / indent
 * restore). Each pass fires ONLY on an unambiguous mapping and otherwise returns
 * its input untouched, so a deliberate edit is never rewritten. Electron-free and
 * dependency-free (explicit `.ts` value imports) so the patch-match harness can
 * load it under plain `--experimental-strip-types`.
 *
 * The model's `newString` is the only thing these touch — the file's bytes are
 * spliced separately from the matched span (see edit-span.resolveNewString).
 */

/* ── item 5: read-view prefix / diff-marker echo strip ──────────────────── */

/**
 * marudesk's anchored read view prefixes each line with `N <hash>\t` where the
 * hash is exactly {@link ANCHOR_LEN} (7) hex chars (text-window.pageLines). A
 * model that echoes the display form into newString writes that prefix verbatim,
 * corrupting the file. Match the anchored prefix (and the plain `N\t` form for a
 * non-anchored read view) so an echoed prefix can be stripped.
 */
const READ_VIEW_PREFIX_RE = /^\s*\d+(?: [0-9a-f]{7})?\t/;
/** A leading unified-diff `+` marker (but not `++`, which is real code). */
const DIFF_PLUS_RE = /^\+(?!\+)/;

/** Lines (LF-split, no trailing CR) carrying any non-whitespace content. */
function countNonEmpty(lines: string[]): number {
  let n = 0;
  for (const line of lines) if (line.trim().length > 0) n += 1;
  return n;
}

/**
 * Strip an echoed read-view prefix (`N <hash>\t`) or unified-diff `+` marker from
 * `lines` — but only when MORE THAN HALF the non-empty lines carry it, so a single
 * real `+` (or a line that merely starts with a number + tab) is never mistaken for
 * an echo. Hash-prefix strip is checked before plus-strip (a prefixed line can also
 * start with `+`). Returns the input array reference unchanged when nothing fires.
 */
export function stripReadViewPrefixes(lines: string[]): string[] {
  const nonEmpty = countNonEmpty(lines);
  if (nonEmpty === 0) return lines;

  let hashCount = 0;
  let plusCount = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (READ_VIEW_PREFIX_RE.test(line)) hashCount += 1;
    if (DIFF_PLUS_RE.test(line)) plusCount += 1;
  }

  // High threshold (> 50%) so false positives are ~0.
  const stripHash = hashCount > 0 && hashCount > nonEmpty * 0.5;
  const stripPlus = !stripHash && plusCount > 0 && plusCount > nonEmpty * 0.5;
  if (!stripHash && !stripPlus) return lines;

  return lines.map((line) => {
    if (stripHash) return line.replace(READ_VIEW_PREFIX_RE, '');
    return line.replace(DIFF_PLUS_RE, '');
  });
}

/* ── item 4: 3-stage replacement-line autocorrect ───────────────────────── */

function stripAllWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

function leadingWhitespace(text: string): string {
  const m = text.match(/^\s*/);
  return m ? m[0] : '';
}

/**
 * Pass A — restore a multi-line block the model collapsed into one line. If the
 * single replacement line's whitespace-stripped content EQUALS the whitespace-
 * stripped content of the matched original block (which had >1 line), expand it
 * back to the original lines. Only fires on that exact 1↔N mapping.
 */
function maybeExpandCollapsedMultiline(originalLines: string[], replacementLines: string[]): string[] {
  if (replacementLines.length !== 1 || originalLines.length <= 1) return replacementLines;
  const collapsed = stripAllWhitespace(replacementLines[0]);
  if (collapsed.length === 0) return replacementLines;
  const originalCanonical = stripAllWhitespace(originalLines.join(''));
  if (collapsed === originalCanonical) return [...originalLines];
  return replacementLines;
}

/**
 * Pass B — restore lines the model accidentally WRAPPED. For each contiguous run
 * of 2..N replacement lines whose joined, whitespace-stripped content uniquely
 * matches a SINGLE original line's content, collapse the run back to that original
 * line. "Uniquely" = exactly one original line has that canonical form AND no other
 * candidate run shares the same canonical — so an ambiguous mapping never fires.
 */
function restoreWrappedLines(originalLines: string[], replacementLines: string[]): string[] {
  if (originalLines.length === 0 || replacementLines.length < 2) return replacementLines;

  const canonicalToOriginal = new Map<string, { line: string; count: number }>();
  for (const line of originalLines) {
    const canonical = stripAllWhitespace(line);
    const existing = canonicalToOriginal.get(canonical);
    if (existing) existing.count += 1;
    else canonicalToOriginal.set(canonical, { line, count: 1 });
  }

  const candidates: { start: number; len: number; replacement: string; canonical: string }[] = [];
  for (let start = 0; start < replacementLines.length; start += 1) {
    for (let len = 2; len <= 10 && start + len <= replacementLines.length; len += 1) {
      const span = replacementLines.slice(start, start + len);
      if (span.some((line) => line.trim().length === 0)) continue;
      const canonicalSpan = stripAllWhitespace(span.join(''));
      const original = canonicalToOriginal.get(canonicalSpan);
      if (original && original.count === 1 && canonicalSpan.length >= 6) {
        candidates.push({ start, len, replacement: original.line, canonical: canonicalSpan });
      }
    }
  }
  if (candidates.length === 0) return replacementLines;

  const canonicalCounts = new Map<string, number>();
  for (const c of candidates) canonicalCounts.set(c.canonical, (canonicalCounts.get(c.canonical) ?? 0) + 1);

  const unique = candidates.filter((c) => (canonicalCounts.get(c.canonical) ?? 0) === 1);
  if (unique.length === 0) return replacementLines;

  // Apply from the end so earlier splice indices stay valid; drop any overlap.
  unique.sort((a, b) => b.start - a.start);
  const corrected = [...replacementLines];
  let lastStart = Infinity;
  for (const c of unique) {
    if (c.start + c.len > lastStart) continue; // overlaps a later-applied run — skip
    corrected.splice(c.start, c.len, c.replacement);
    lastStart = c.start;
  }
  return corrected;
}

/**
 * Pass C — restore indentation for a 1:1 line mapping. When replacement and
 * original have the SAME line count and a replacement line lost its leading
 * whitespace (but the original line had some, and the trimmed text differs),
 * re-apply the original line's indentation. Skips lines the model deliberately
 * re-indented (already has leading whitespace) and pure no-ops (same trimmed text).
 */
function restoreIndentPaired(originalLines: string[], replacementLines: string[]): string[] {
  if (originalLines.length !== replacementLines.length) return replacementLines;
  return replacementLines.map((line, idx) => {
    if (line.length === 0) return line;
    if (leadingWhitespace(line).length > 0) return line;
    const indent = leadingWhitespace(originalLines[idx]);
    if (indent.length === 0) return line;
    if (originalLines[idx].trim() === line.trim()) return line;
    return `${indent}${line}`;
  });
}

/**
 * Run the replacement-line autocorrect passes in order against the matched ORIGINAL
 * block. Each pass is a no-op unless its mapping is unambiguous, so the sequence is
 * safe to default-on. Operates on LF-split lines (caller restores the file's real
 * line endings via the splice of the matched span).
 *
 * `restoreIndent` gates the paired indent-restore pass (Pass C): the fuzzy edit path
 * owns indentation via shared/patch.adjustNewIndent (a uniform-delta shift), so it
 * skips Pass C to avoid double-indenting; the exact-match path keeps it on (no delta
 * pass runs there).
 */
export function autocorrectReplacementLines(
  originalLines: string[],
  replacementLines: string[],
  opts: { restoreIndent: boolean } = { restoreIndent: true },
): string[] {
  let next = replacementLines;
  next = maybeExpandCollapsedMultiline(originalLines, next);
  next = restoreWrappedLines(originalLines, next);
  if (opts.restoreIndent) next = restoreIndentPaired(originalLines, next);
  return next;
}

/* ── orchestrator over the raw newString ────────────────────────────────── */

/** Split into lines, remembering a trailing CR per line so we can restore it. */
function splitKeepCR(text: string): { lines: string[]; cr: boolean[] } {
  const raw = text.split('\n');
  const lines: string[] = [];
  const cr: boolean[] = [];
  for (const r of raw) {
    if (r.endsWith('\r')) {
      lines.push(r.slice(0, -1));
      cr.push(true);
    } else {
      lines.push(r);
      cr.push(false);
    }
  }
  return { lines, cr };
}

/**
 * Normalize the model's `newString` for a fuzzy/verbatim edit: strip an echoed
 * read-view/diff prefix (item 5), then run the 3-stage replacement-line autocorrect
 * (item 4) against the matched original block (`actualText`, the file's real spanned
 * bytes). Returns `newString` UNCHANGED whenever no pass has an unambiguous mapping,
 * so it can never corrupt an intentional replacement. Trailing CRs are preserved on
 * untouched lines so a CRLF file's surviving lines keep their endings.
 *
 * `restoreIndent` is forwarded to the paired indent-restore pass; the fuzzy edit
 * path passes false and lets adjustNewIndent own indentation (see resolveNewString).
 */
export function autocorrectNewString(
  actualText: string,
  newString: string,
  opts: { restoreIndent: boolean } = { restoreIndent: true },
): string {
  const { lines: newLines, cr } = splitKeepCR(newString);
  const originalLines = actualText.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

  const stripped = stripReadViewPrefixes(newLines);
  const corrected = autocorrectReplacementLines(originalLines, stripped, opts);

  // Reassemble. If the autocorrect changed the line COUNT (collapsed/expanded), the
  // CR map no longer aligns 1:1 — re-derive endings from the original newString's
  // predominant ending instead of forcing a stale per-line CR map.
  if (corrected.length === newLines.length) {
    return corrected.map((line, i) => (cr[i] ? `${line}\r` : line)).join('\n');
  }
  const usedCRLF = cr.some((c) => c);
  return corrected.join(usedCRLF ? '\r\n' : '\n');
}
