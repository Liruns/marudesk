/**
 * Pure unified-diff helpers for the bridge's remote edit projection
 * (shared/remote.ts `RemoteEditDiff`). The main process keeps each agent edit as
 * full `before`/`after` content (shared/agent.ts `AgentEdit`); thin clients need
 * a BOUNDED text view instead, so the server boundary renders a compact unified
 * diff here and clips it. Same common prefix/suffix trim as the renderer's
 * src/features/agent/diff.ts — the agent's edits are localized replacements, so
 * trimming the shared head/tail plus a little context reads cleanly and stays
 * cheap (no LCS).
 *
 * Kept in shared/ (pure, dependency-free) so main, harnesses, and tests reuse
 * one implementation.
 */

/** Context lines kept around the changed region, mirroring the renderer's diff. */
const CONTEXT = 2;

/** Appended (on its own line) when a diff was clipped to the byte budget. */
export const EDIT_DIFF_TRUNCATION_MARKER = '… diff truncated …';

export type UnifiedDiffResult = {
  /** `@@ -a,b +c,d @@` hunk + ` `/`-`/`+`-prefixed lines; '' for a no-op edit. */
  diff: string;
  /** Added line count of the changed region (uncapped, pre-clip). */
  additions: number;
  /** Removed line count of the changed region (uncapped, pre-clip). */
  deletions: number;
};

/**
 * Render a single-hunk unified diff for one edit. `before === null` means a
 * created file (every line is an addition). Total: never throws.
 */
export function buildUnifiedDiff(before: string | null, after: string): UnifiedDiffResult {
  const b = after.split('\n');
  if (before === null) {
    const additions = after.length === 0 ? 0 : b.length;
    if (additions === 0) return { diff: '', additions: 0, deletions: 0 };
    const lines = [`@@ -0,0 +1,${additions} @@`, ...b.map((line) => `+${line}`)];
    return { diff: lines.join('\n'), additions, deletions: 0 };
  }
  const a = before.split('\n');

  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let sa = a.length - 1;
  let sb = b.length - 1;
  while (sa >= p && sb >= p && a[sa] === b[sb]) {
    sa--;
    sb--;
  }

  const deletions = Math.max(0, sa - p + 1);
  const additions = Math.max(0, sb - p + 1);
  if (deletions === 0 && additions === 0) return { diff: '', additions: 0, deletions: 0 };

  const ctxStart = Math.max(0, p - CONTEXT);
  const tailEnd = Math.min(a.length, sa + 1 + CONTEXT);
  const leadCtx = p - ctxStart;
  const tailCtx = tailEnd - (sa + 1);

  const lines: string[] = [
    `@@ -${ctxStart + 1},${leadCtx + deletions + tailCtx} +${ctxStart + 1},${leadCtx + additions + tailCtx} @@`,
  ];
  for (let i = ctxStart; i < p; i++) lines.push(` ${a[i]}`);
  for (let i = p; i <= sa; i++) lines.push(`-${a[i]}`);
  for (let i = p; i <= sb; i++) lines.push(`+${b[i]}`);
  for (let i = sa + 1; i < tailEnd; i++) lines.push(` ${a[i]}`);
  return { diff: lines.join('\n'), additions, deletions };
}

/**
 * Clip a diff to `maxChars`, cutting at a line boundary and appending the
 * truncation marker so a thin client can show "diff continues on the desktop".
 */
export function clipDiffText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.lastIndexOf('\n', maxChars);
  const head = text.slice(0, cut > 0 ? cut : maxChars);
  return { text: `${head}\n${EDIT_DIFF_TRUNCATION_MARKER}`, truncated: true };
}
