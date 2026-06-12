import type {
  GitBlameLine,
  GitChange,
  GitDiffLineRange,
  GitFileStatus,
} from '../shared/git';

/**
 * Pure parsers for git CLI porcelain output (status -z records, --branch
 * headers) and a stdout/stderr summarizer. No fs/exec — split out of git.ts so
 * the handler module holds the command plumbing and these stay unit-testable.
 */

/** Parse one `git status --porcelain=v1 -z` record stream into changes. */
export function parseStatus(records: string[]): GitChange[] {
  const files: GitChange[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 4) continue;
    const x = rec[0] as GitFileStatus;
    const y = rec[1] as GitFileStatus;
    // rec is "XY <path>"; the space at index 2 separates the code from path.
    let path = rec.slice(3);
    let origPath: string | null = null;
    // A rename/copy ("R"/"C" in either column) is "XY <new>\0<old>" — the old
    // path is the NEXT NUL-delimited record, which -z splits off separately.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      origPath = records[i + 1] ?? null;
      i++; // consume the orig-path record
    }
    const untracked = x === '?' && y === '?';
    const conflicted =
      x === 'U' ||
      y === 'U' ||
      (x === 'A' && y === 'A') ||
      (x === 'D' && y === 'D');
    path = path.replace(/\\/g, '/');
    files.push({
      path,
      origPath: origPath ? origPath.replace(/\\/g, '/') : null,
      indexStatus: x,
      worktreeStatus: y,
      // Untracked + conflicted files have no meaningful "staged" half.
      staged: !untracked && !conflicted && x !== ' ',
      untracked,
      conflicted,
    });
  }
  return files;
}

/** Read branch + upstream + ahead/behind from `--branch -z` header records. */
export function parseBranchHeaders(records: string[]): {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  unborn: boolean;
} {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let unborn = false;
  for (const rec of records) {
    if (!rec.startsWith('##')) break;
    // Examples:
    //   "## main...origin/main [ahead 1, behind 2]"
    //   "## main...origin/main"
    //   "## main"
    //   "## No commits yet on main"
    //   "## HEAD (no branch)"
    const body = rec.slice(2).trim();
    if (body.startsWith('No commits yet on ')) {
      branch = body.slice('No commits yet on '.length).trim();
      unborn = true;
      continue;
    }
    if (body.startsWith('HEAD (no branch)')) {
      branch = null; // detached
      continue;
    }
    const trackMatch = body.match(/^(.+?)\.\.\.(\S+)(?:\s+\[(.+)\])?$/);
    if (trackMatch) {
      branch = trackMatch[1];
      upstream = trackMatch[2];
      const stats = trackMatch[3];
      if (stats) {
        const a = stats.match(/ahead (\d+)/);
        const b = stats.match(/behind (\d+)/);
        if (a) ahead = Number(a[1]);
        if (b) behind = Number(b[1]);
      }
    } else {
      branch = body || null;
    }
  }
  return { branch, upstream, ahead, behind, unborn };
}

/**
 * Parse `git diff --unified=0` output into per-line change ranges for the diff
 * gutter. With zero context lines every hunk header maps 1:1 to a change:
 *   - `+c,0` (no new lines)  → pure deletion AFTER line c of the new file;
 *   - `-a,0` (no old lines)  → pure addition at new lines c..c+d-1;
 *   - both sides non-zero    → modification at new lines c..c+d-1.
 * Counts default to 1 when omitted (`@@ -3 +3 @@`).
 */
export function parseUnifiedZeroDiff(stdout: string): {
  ranges: GitDiffLineRange[];
  deletedAfter: number[];
} {
  const ranges: GitDiffLineRange[] = [];
  const deletedAfter: number[] = [];
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  for (const line of stdout.split('\n')) {
    const m = hunk.exec(line);
    if (!m) continue;
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (newCount === 0) {
      deletedAfter.push(newStart);
    } else {
      ranges.push({
        startLine: newStart,
        endLine: newStart + newCount - 1,
        kind: oldCount === 0 ? 'added' : 'modified',
      });
    }
  }
  return { ranges, deletedAfter };
}

/**
 * Parse `git blame --line-porcelain` output into per-line blame entries. In
 * line-porcelain mode EVERY line repeats the full commit header block
 * (`<hash> <orig> <final>` then `author`/`author-time`/`summary`/… tags) and
 * ends with the tab-prefixed content line, so parsing is stateless per entry.
 */
export function parseLinePorcelainBlame(stdout: string): GitBlameLine[] {
  const out: GitBlameLine[] = [];
  const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;
  let cur: { hash: string; line: number } | null = null;
  let author = '';
  let authorTime = 0;
  let summary = '';
  for (const line of stdout.split('\n')) {
    const h = header.exec(line);
    if (h) {
      cur = { hash: h[1], line: Number(h[2]) };
      author = '';
      authorTime = 0;
      summary = '';
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('\t')) {
      // The content line terminates this entry.
      out.push({ line: cur.line, hash: cur.hash, author, authorTime, summary });
      cur = null;
    } else if (line.startsWith('author ')) {
      author = line.slice('author '.length);
    } else if (line.startsWith('author-time ')) {
      authorTime = Number(line.slice('author-time '.length)) || 0;
    } else if (line.startsWith('summary ')) {
      summary = line.slice('summary '.length);
    }
  }
  return out;
}

export function summarize(stdout: string, stderr: string, fallback: string): string {
  // git writes progress + summary to stderr; prefer the last non-empty line.
  const lines = `${stderr}\n${stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  return last && last.length > 0 ? last : fallback;
}
