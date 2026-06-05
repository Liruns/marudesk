import type { GitChange, GitFileStatus } from '../shared/git';

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

export function summarize(stdout: string, stderr: string, fallback: string): string {
  // git writes progress + summary to stderr; prefer the last non-empty line.
  const lines = `${stderr}\n${stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  return last && last.length > 0 ? last : fallback;
}
