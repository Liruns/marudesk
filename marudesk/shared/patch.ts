export type PatchOp = {
  path: string;
  oldString: string;
  newString: string;
  /**
   * Optional hash anchor (v6 §W1 "B" layer): a read-view per-line content hash
   * that locates the line to edit instead of a verbatim `oldString`. When set,
   * the matcher resolves the span by the line's UNIQUE hash (token-cheap, no
   * ambiguity) and a hash that no longer matches is rejected as a stale anchor —
   * the file changed since it was read. `oldString` may be empty when an anchor
   * is supplied. Purely additive: an op without an anchor uses the A-layer
   * `oldString` path unchanged.
   */
  anchor?: string;
  /**
   * Optional end anchor: extends an anchored edit to span from {@link anchor}'s
   * line through this line (inclusive), for multi-line replacements. Single-line
   * edits omit it.
   */
  endAnchor?: string;
  /**
   * Optional 1-based line-number HINT for {@link anchor} (the line number the read
   * view showed next to the hash). When present, the matcher checks that exact line
   * first, so two identical lines are no longer rejected as ambiguous; a wrong/stale
   * hint falls back to the unique whole-file hash scan. Purely additive.
   */
  anchorLine?: number;
  /** 1-based line-number hint for {@link endAnchor} (same semantics as {@link anchorLine}). */
  endAnchorLine?: number;
};

export type PatchOpPreview =
  | {
      kind: 'edit';
      path: string;
      startLine: number;
      oldString: string;
      newString: string;
    }
  | {
      kind: 'create';
      path: string;
      newString: string;
    }
  | {
      kind: 'error';
      path: string;
      reason: string;
    };

export type PatchPreview = {
  ops: PatchOpPreview[];
  hasErrors: boolean;
};

export type ApplyOutcome = {
  path: string;
  kind: 'edit' | 'create';
};

export type ApplyError = {
  path: string;
  reason: string;
};

/**
 * The before/after content of one successfully-applied op — captured so the
 * agentic chat can show a diff and revert it (roadmap P2). The atomic apply
 * already reads `before` and computes `after`; this just surfaces them.
 */
export type AppliedChange = {
  path: string;
  kind: 'edit' | 'create';
  /** Pre-apply content, or null for a created file. */
  before: string | null;
  after: string;
};

export type ApplyResult = {
  ok: boolean;
  applied: ApplyOutcome[];
  errors: ApplyError[];
  /** Present only on a fully-successful apply (ok: true). */
  changes?: AppliedChange[];
};

/**
 * Canonical runtime guards for a {@link PatchOp}. A valid op needs a non-empty
 * path plus string old/new content. Shared by the patch handler (validating the
 * renderer payload) and the LLM tool-output validator so the two can't diverge.
 */
export function isPatchOp(value: unknown): value is PatchOp {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' &&
    v.path.length > 0 &&
    typeof v.oldString === 'string' &&
    typeof v.newString === 'string' &&
    // Optional anchors, when present, must be strings (v6 §W1 B-layer).
    (v.anchor === undefined || typeof v.anchor === 'string') &&
    (v.endAnchor === undefined || typeof v.endAnchor === 'string') &&
    // Optional line-number hints, when present, must be positive integers.
    (v.anchorLine === undefined ||
      (typeof v.anchorLine === 'number' && Number.isInteger(v.anchorLine) && v.anchorLine >= 1)) &&
    (v.endAnchorLine === undefined ||
      (typeof v.endAnchorLine === 'number' && Number.isInteger(v.endAnchorLine) && v.endAnchorLine >= 1))
  );
}

export function isPatchOpArray(value: unknown): value is PatchOp[] {
  return Array.isArray(value) && value.every(isPatchOp);
}

/* ── match location (v6 §W1 Hashline — A fallback) ──────────────────────── */

/**
 * Where an `oldString` lands in `content`, as a `[start, end)` char span. Exact
 * `indexOf` first (the common, zero-ambiguity path); when that misses, a
 * whitespace-tolerant line-based fallback (the v6 §W1 "A" layer) so a stray CRLF,
 * indentation drift, or trailing blank doesn't fail the whole edit. The fallback
 * stays SAFE by refusing ambiguous matches: it locates leniently but only when the
 * normalized block matches exactly one place, then the caller replaces the *real*
 * bytes in that span (so the file's true indentation/line-endings are preserved).
 */
export type PatchMatch =
  | { ok: true; start: number; end: number; fuzzy: boolean }
  | { ok: false; reason: 'not-found' | 'ambiguous' };

export function locatePatch(content: string, oldString: string): PatchMatch {
  // 1. Exact match — must be unique (unchanged semantics).
  const first = content.indexOf(oldString);
  if (first >= 0) {
    const second = content.indexOf(oldString, first + oldString.length);
    if (second >= 0) return { ok: false, reason: 'ambiguous' };
    return { ok: true, start: first, end: first + oldString.length, fuzzy: false };
  }
  return locateFuzzy(content, oldString);
}

/**
 * Fold typographic look-alikes to their ASCII equivalents FOR COMPARISON ONLY —
 * never for the bytes written. Web/markdown paste turns straight quotes into
 * curly ones, hyphens into en/em dashes, and spaces into NBSP/zero-width, so a
 * model's oldString and the file's real bytes differ only in these code-points
 * and both exact `indexOf` and a CR+trim fuzzy match miss. Folding them here lets
 * the fuzzy locator find the block; the caller still splices the file's REAL
 * bytes from the matched span, so the original characters are preserved verbatim.
 */
function foldTypography(s: string): string {
  return (
    s
      // Fancy single quotes / backtick / acute accent -> '
      .replace(/[\u2018\u2019\u201A\u201B\u0060\u00B4]/g, "'")
      // Fancy double quotes / guillemets -> "
      .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
      // Hyphens / en+em dashes / minus sign -> -
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      // NBSP / narrow + wide spaces -> a normal space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
      // Zero-width characters (incl. a mid-string BOM) -> removed
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
  );
}

/** Per-line whitespace-insensitive (and CRLF-insensitive) block match. */
function locateFuzzy(content: string, oldString: string): PatchMatch {
  const contentLines = content.split('\n');
  // Char offset where each content line begins (+1 per stripped '\n').
  const offsets: number[] = new Array(contentLines.length);
  for (let i = 0, acc = 0; i < contentLines.length; i++) {
    offsets[i] = acc;
    acc += contentLines[i].length + 1;
  }

  // Normalize for LOCATING only: strip a trailing CR, trim, and fold typographic
  // look-alikes (curly quotes, en/em dashes, NBSP, zero-width) to ASCII. The span
  // we return still points at the file's untouched bytes — the caller splices the
  // real text, so the file's true characters/line-endings are preserved.
  const norm = (s: string): string => foldTypography(s.replace(/\r$/, '')).trim();
  const old = oldString.split('\n').map(norm);
  // Tolerate stray leading/trailing blank lines in the model's oldString.
  while (old.length > 1 && old[old.length - 1] === '') old.pop();
  while (old.length > 1 && old[0] === '') old.shift();
  if (old.length === 0 || (old.length === 1 && old[0] === '')) {
    return { ok: false, reason: 'not-found' };
  }

  const n = old.length;
  const starts: number[] = [];
  for (let i = 0; i + n <= contentLines.length; i++) {
    let hit = true;
    for (let j = 0; j < n; j++) {
      if (norm(contentLines[i + j]) !== old[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      starts.push(i);
      if (starts.length > 1) return { ok: false, reason: 'ambiguous' };
    }
  }
  if (starts.length === 0) return { ok: false, reason: 'not-found' };

  const startLine = starts[0];
  const endLine = startLine + n - 1;
  const start = offsets[startLine];
  // Exclude the last matched line's trailing '\r' from the span so a CRLF file
  // keeps its '\r\n' after the replacement (we matched LF-normalized).
  const last = contentLines[endLine];
  const lastLen = last.endsWith('\r') ? last.length - 1 : last.length;
  const end = offsets[endLine] + lastLen;
  return { ok: true, start, end, fuzzy: true };
}

/* ── indentation-delta adjustment (fuzzy match, EDIT-2 §3) ──────────────── */

/** Leading run of spaces/tabs on one line (the trailing CR is irrelevant — already trimmed by callers). */
function leadingIndent(line: string): string {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : '';
}

/** A line is "blank" for indent purposes when it has no non-whitespace content. */
function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * When a fuzzy match landed a block at a DIFFERENT (but uniform) indentation than
 * the model's `oldString`, shift `newString` by that same indent delta so the
 * written result keeps the file's REAL indentation instead of the model's guess.
 *
 * Pure and conservative — returns `newString` UNCHANGED unless every signal lines
 * up, so it can never corrupt an intentional indentation change:
 *   - both `oldString` and `actualText` have the SAME number of non-blank lines;
 *   - the per-line indent delta (actual − old) is the SAME nonzero value on every
 *     non-blank pair (a single uniform shift, not a reflow);
 *   - the indentation is single-character (all spaces OR all tabs), so a delta is
 *     meaningful — mixed/!uniform indentation is left alone;
 *   - the edit is not a pure re-indentation (old/new trimmed content identical),
 *     where the model's indentation IS the intent.
 * `actualText` is the file's real spanned bytes (LF-normalized, no trailing CR).
 */
export function adjustNewIndent(oldString: string, actualText: string, newString: string): string {
  // If the model's oldString already equals the matched bytes, its indentation is
  // correct as-is — never touch newString (this also covers the exact-match path).
  if (oldString === actualText) return newString;

  const stripCR = (s: string): string[] => s.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const oldLines = stripCR(oldString);
  const actLines = stripCR(actualText);
  const newLines = stripCR(newString);

  // A pure re-indentation (same trimmed content, line-for-line) means the model is
  // deliberately changing indentation — keep its newString verbatim.
  if (oldLines.length === newLines.length && oldLines.every((l, i) => l.trim() === newLines[i].trim())) {
    return newString;
  }

  // Pair non-blank lines of old vs actual and require ONE uniform, nonzero delta.
  const oldNonBlank = oldLines.filter((l) => !isBlankLine(l));
  const actNonBlank = actLines.filter((l) => !isBlankLine(l));
  if (oldNonBlank.length === 0 || oldNonBlank.length !== actNonBlank.length) return newString;

  const charSet = new Set<string>();
  let delta = 0;
  for (let i = 0; i < oldNonBlank.length; i++) {
    const oi = leadingIndent(oldNonBlank[i]);
    const ai = leadingIndent(actNonBlank[i]);
    // Require single-character indentation on both sides so the count is a real delta.
    if (/ /.test(oi)) charSet.add(' ');
    if (/\t/.test(oi)) charSet.add('\t');
    if (/ /.test(ai)) charSet.add(' ');
    if (/\t/.test(ai)) charSet.add('\t');
    const d = ai.length - oi.length;
    if (i === 0) delta = d;
    else if (d !== delta) return newString; // not a uniform shift
  }
  if (delta === 0 || charSet.size > 1) return newString;

  // The indent character to add (positive delta): the one actually used by the file.
  const indentChar = charSet.has('\t') ? '\t' : ' ';
  const shifted = newLines.map((line) => {
    if (isBlankLine(line)) return line; // leave blank lines untouched
    if (delta > 0) return indentChar.repeat(delta) + line;
    const cur = leadingIndent(line);
    const remove = Math.min(-delta, cur.length);
    return line.slice(remove);
  });
  return shifted.join('\n');
}
