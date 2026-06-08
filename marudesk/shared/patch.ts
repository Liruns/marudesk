export type PatchOp = {
  path: string;
  oldString: string;
  newString: string;
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
    typeof v.newString === 'string'
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

/** Per-line whitespace-insensitive (and CRLF-insensitive) block match. */
function locateFuzzy(content: string, oldString: string): PatchMatch {
  const contentLines = content.split('\n');
  // Char offset where each content line begins (+1 per stripped '\n').
  const offsets: number[] = new Array(contentLines.length);
  for (let i = 0, acc = 0; i < contentLines.length; i++) {
    offsets[i] = acc;
    acc += contentLines[i].length + 1;
  }

  const norm = (s: string): string => s.replace(/\r$/, '').trim();
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
