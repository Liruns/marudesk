import type { DiffLine } from '../../components/ui';

/**
 * Parse git's unified-diff text (the output of `git diff [--cached] -- file`)
 * into the {@link DiffLine}[] the shared DiffBlock renders. We only need the
 * body hunks: file headers (`diff --git`, `index`, `+++`, `---`) are dropped,
 * and `@@` hunk headers seed the running old/new line counters.
 *
 * Output is capped so a huge diff can't blow up the panel.
 */

const MAX_LINES = 600;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLn = 0;
  let newLn = 0;
  for (const raw of diff.split('\n')) {
    if (out.length >= MAX_LINES) {
      out.push({ kind: 'context', content: '… diff truncated' });
      break;
    }
    if (raw.startsWith('@@')) {
      // @@ -oldStart,oldCount +newStart,newCount @@
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLn = Number(m[1]);
        newLn = Number(m[2]);
      }
      continue;
    }
    // Skip file-level headers (kept terse — the panel already names the file).
    if (
      raw.startsWith('diff --git') ||
      raw.startsWith('index ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('similarity ') ||
      raw.startsWith('rename ') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('\\ No newline')
    ) {
      continue;
    }
    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === '+') {
      out.push({ kind: 'add', newLineNumber: newLn, content });
      newLn++;
    } else if (marker === '-') {
      out.push({ kind: 'remove', oldLineNumber: oldLn, content });
      oldLn++;
    } else if (marker === ' ') {
      out.push({
        kind: 'context',
        oldLineNumber: oldLn,
        newLineNumber: newLn,
        content,
      });
      oldLn++;
      newLn++;
    }
    // An empty line (no marker) at EOF is ignored.
  }
  return out;
}
