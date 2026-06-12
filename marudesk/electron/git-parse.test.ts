import { describe, it, expect } from 'vitest';
import {
  parseBranchHeaders,
  parseLinePorcelainBlame,
  parseStashList,
  parseStatus,
  parseUnifiedZeroDiff,
  summarize,
} from './git-parse';

describe('parseStatus', () => {
  it('parses staged, modified, and untracked entries', () => {
    const files = parseStatus(['M  src/a.ts', ' M src/b.ts', '?? src/c.ts']);
    expect(files).toEqual([
      expect.objectContaining({ path: 'src/a.ts', indexStatus: 'M', staged: true, untracked: false }),
      expect.objectContaining({ path: 'src/b.ts', worktreeStatus: 'M', staged: false }),
      expect.objectContaining({ path: 'src/c.ts', untracked: true, staged: false }),
    ]);
  });

  it('pairs a rename with its NUL-split original path', () => {
    const files = parseStatus(['R  new.ts', 'old.ts']);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'new.ts', origPath: 'old.ts', staged: true });
  });

  it('flags conflicts (UU) as not staged', () => {
    const [f] = parseStatus(['UU src/x.ts']);
    expect(f).toMatchObject({ conflicted: true, staged: false });
  });

  it('flags every unmerged XY code as conflicted', () => {
    const records = [
      'AA both.ts', // both added
      'DD gone.ts', // both deleted
      'AU added-us.ts',
      'UA added-them.ts',
      'DU deleted-us.ts',
      'UD deleted-them.ts',
      'UU classic.ts',
    ];
    const files = parseStatus(records);
    expect(files).toHaveLength(records.length);
    for (const f of files) {
      expect(f.conflicted).toBe(true);
      expect(f.staged).toBe(false);
      expect(f.untracked).toBe(false);
    }
  });
});

describe('parseStashList', () => {
  it('parses ref, timestamp, and message records', () => {
    const out = parseStashList(
      [
        'stash@{0}|1718000000|WIP on main: abc123 fix the thing',
        'stash@{1}|1717000000|my named stash',
        '',
      ].join('\n'),
    );
    expect(out).toEqual([
      { ref: 'stash@{0}', timestamp: 1718000000, message: 'WIP on main: abc123 fix the thing' },
      { ref: 'stash@{1}', timestamp: 1717000000, message: 'my named stash' },
    ]);
  });

  it('keeps "|" inside the message intact', () => {
    const [entry] = parseStashList('stash@{0}|1718000000|left | right | end');
    expect(entry.message).toBe('left | right | end');
  });

  it('skips malformed lines and empty input', () => {
    expect(parseStashList('')).toEqual([]);
    expect(parseStashList('garbage line\nstash@{0}|not-a-number|msg\n|1|x')).toEqual([]);
  });
});

describe('parseBranchHeaders', () => {
  it('reads branch + upstream + ahead/behind', () => {
    expect(parseBranchHeaders(['## main...origin/main [ahead 1, behind 2]'])).toEqual({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 2,
      unborn: false,
    });
  });

  it('detects an unborn branch (no commits yet)', () => {
    expect(parseBranchHeaders(['## No commits yet on main'])).toMatchObject({
      branch: 'main',
      unborn: true,
    });
  });

  it('treats detached HEAD as no branch', () => {
    expect(parseBranchHeaders(['## HEAD (no branch)']).branch).toBeNull();
  });
});

describe('summarize', () => {
  it('prefers the last non-empty line, stderr first', () => {
    expect(summarize('done\n', 'progress\nwarn\n', 'fallback')).toBe('done');
  });

  it('falls back when there is no output', () => {
    expect(summarize('', '   \n', 'fallback')).toBe('fallback');
  });
});

describe('parseUnifiedZeroDiff', () => {
  it('classifies additions, modifications, and deletions from zero-context hunks', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -0,0 +1,2 @@', // pure addition: new lines 1-2
      '+a',
      '+b',
      '@@ -5,2 +7,3 @@', // modification: new lines 7-9
      '-x',
      '-y',
      '+p',
      '+q',
      '+r',
      '@@ -12,3 +14,0 @@', // pure deletion after new line 14
      '-gone',
      '-gone',
      '-gone',
      '',
    ].join('\n');
    expect(parseUnifiedZeroDiff(diff)).toEqual({
      ranges: [
        { startLine: 1, endLine: 2, kind: 'added' },
        { startLine: 7, endLine: 9, kind: 'modified' },
      ],
      deletedAfter: [14],
    });
  });

  it('defaults omitted counts to 1 and reports a leading deletion as 0', () => {
    const diff = '@@ -3 +3 @@\n-x\n+y\n@@ -1 +0,0 @@\n-gone\n';
    expect(parseUnifiedZeroDiff(diff)).toEqual({
      ranges: [{ startLine: 3, endLine: 3, kind: 'modified' }],
      deletedAfter: [0],
    });
  });

  it('returns empty maps for an empty diff', () => {
    expect(parseUnifiedZeroDiff('')).toEqual({ ranges: [], deletedAfter: [] });
  });
});

describe('parseLinePorcelainBlame', () => {
  it('extracts author/time/summary per line', () => {
    const hash = 'a'.repeat(40);
    const out = parseLinePorcelainBlame(
      [
        `${hash} 1 1 2`,
        'author Ada',
        'author-mail <ada@example.com>',
        'author-time 1700000000',
        'author-tz +0000',
        'committer Ada',
        'summary first commit',
        'filename f.ts',
        '\tline one',
        `${hash} 2 2`,
        'author Ada',
        'author-time 1700000000',
        'summary first commit',
        'filename f.ts',
        '\tline two',
        '',
      ].join('\n'),
    );
    expect(out).toEqual([
      { line: 1, hash, author: 'Ada', authorTime: 1700000000, summary: 'first commit' },
      { line: 2, hash, author: 'Ada', authorTime: 1700000000, summary: 'first commit' },
    ]);
  });

  it('returns [] for empty/garbage input', () => {
    expect(parseLinePorcelainBlame('')).toEqual([]);
    expect(parseLinePorcelainBlame('not blame output\n')).toEqual([]);
  });
});
