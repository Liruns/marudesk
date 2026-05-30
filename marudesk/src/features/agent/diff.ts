import type { DiffLine } from '../../components/ui';

/**
 * A compact line-level diff (common prefix/suffix trim) for an agent edit card.
 * Not a full LCS — the agent's edits are localized string replacements, so
 * trimming the shared head/tail and showing the changed middle (plus a little
 * context) reads cleanly and stays cheap. Output is capped so a large rewrite
 * can't blow up the panel.
 */

const MAX_LINES = 80;
const CONTEXT = 2;

export function toDiffLines(before: string | null, after: string): DiffLine[] {
  const b = after.split('\n');
  if (before === null) {
    // A created file — every line is an addition.
    return cap(b.map((content, i) => ({ kind: 'add' as const, newLineNumber: i + 1, content })));
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

  const lines: DiffLine[] = [];
  const ctxStart = Math.max(0, p - CONTEXT);
  for (let i = ctxStart; i < p; i++) {
    lines.push({ kind: 'context', oldLineNumber: i + 1, newLineNumber: i + 1, content: a[i] });
  }
  for (let i = p; i <= sa; i++) {
    lines.push({ kind: 'remove', oldLineNumber: i + 1, content: a[i] });
  }
  for (let i = p; i <= sb; i++) {
    lines.push({ kind: 'add', newLineNumber: i + 1, content: b[i] });
  }
  const tailEnd = Math.min(a.length, sa + 1 + CONTEXT);
  for (let i = sa + 1; i < tailEnd; i++) {
    const newLine = sb + 1 + (i - (sa + 1)) + 1;
    lines.push({ kind: 'context', oldLineNumber: i + 1, newLineNumber: newLine, content: a[i] });
  }
  return cap(lines);
}

function cap(lines: DiffLine[]): DiffLine[] {
  if (lines.length <= MAX_LINES) return lines;
  return [
    ...lines.slice(0, MAX_LINES),
    { kind: 'context', content: `… ${lines.length - MAX_LINES} more line(s)` },
  ];
}
