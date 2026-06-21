import { describe, expect, it } from 'vitest';
import { changedFilePaths } from './parseDiff';

describe('changedFilePaths', () => {
  it('extracts the post-change path from a single-file diff', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 111..222 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' context',
    ].join('\n');
    expect(changedFilePaths(diff)).toEqual(['src/foo.ts']);
  });

  it('lists every changed file, in first-seen order, de-duplicated', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n');
    expect(changedFilePaths(diff)).toEqual(['a.ts', 'b.ts']);
  });

  it('skips /dev/null (deleted file new side) but keeps the diff-header path', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');
    expect(changedFilePaths(diff)).toEqual(['gone.ts']);
  });

  it('falls back to the diff --git b/ path when no +++ header is present', () => {
    const diff = ['diff --git a/mode.ts b/mode.ts', 'old mode 100644', 'new mode 100755'].join('\n');
    expect(changedFilePaths(diff)).toEqual(['mode.ts']);
  });

  it('returns an empty list for an empty diff', () => {
    expect(changedFilePaths('')).toEqual([]);
  });

  it('handles a +++ header with no b/ prefix', () => {
    const diff = ['+++ plain/path.ts', '@@ -1 +1 @@', '+z'].join('\n');
    expect(changedFilePaths(diff)).toEqual(['plain/path.ts']);
  });
});
