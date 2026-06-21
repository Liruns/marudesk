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

/**
 * Extract the changed workspace-relative file paths from a unified diff, in
 * first-seen order, de-duplicated. We read the `+++ b/<path>` header (the
 * post-change path — the version to open) and fall back to the `diff --git`
 * header so renames / deletes still surface a path. `/dev/null` (a deleted
 * file's new side) is skipped: there is nothing to open.
 *
 * Used by the Work OS inspector to make each changed file in a proposed diff
 * openable as the editor instrument (before/after review), reusing the same
 * `openFileInstrument` hop Search + Source Control use.
 */
export function changedFilePaths(diff: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (path: string): void => {
    if (!path || path === '/dev/null' || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      // `+++ b/path` (or `+++ path`); strip the `b/` prefix git emits.
      const path = raw.slice(4).trim().replace(/^b\//, '');
      add(path);
    } else if (raw.startsWith('diff --git ')) {
      // `diff --git a/path b/path` — the `b/` side is the post-change path. This
      // is the fallback for entries with no `+++` (e.g. pure mode changes).
      // Anchor to the full `a/… b/…` shape so a path that itself contains ` b/`
      // can't be mis-captured by a floating match (machine-generated input, but
      // belt-and-suspenders for the fallback branch).
      const m = raw.match(/^diff --git a\/.+ b\/(.+)$/);
      if (m) add(m[1].trim());
    }
  }
  return out;
}
