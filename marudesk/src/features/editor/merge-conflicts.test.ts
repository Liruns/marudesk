import { describe, it, expect } from 'vitest';
import {
  applyConflictChoice,
  findConflictBlocks,
} from './merge-conflicts';

const SIMPLE = [
  'before',
  '<<<<<<< HEAD',
  'ours line',
  '=======',
  'theirs line',
  '>>>>>>> feature',
  'after',
].join('\n');

describe('findConflictBlocks', () => {
  it('parses a simple block with labels and 1-based lines', () => {
    const blocks = findConflictBlocks(SIMPLE);
    expect(blocks).toEqual([
      {
        start: 2,
        base: null,
        sep: 4,
        end: 6,
        currentLabel: 'HEAD',
        incomingLabel: 'feature',
      },
    ]);
  });

  it('finds multiple independent blocks', () => {
    const text = [
      '<<<<<<< HEAD',
      'a',
      '=======',
      'b',
      '>>>>>>> x',
      'mid',
      '<<<<<<< HEAD',
      'c',
      '=======',
      'd',
      '>>>>>>> y',
    ].join('\n');
    const blocks = findConflictBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ start: 1, sep: 3, end: 5 });
    expect(blocks[1]).toMatchObject({ start: 7, sep: 9, end: 11 });
  });

  it('records the diff3 base marker and keeps it out of both sides', () => {
    const text = [
      '<<<<<<< HEAD',
      'ours',
      '||||||| merged common ancestors',
      'base',
      '=======',
      'theirs',
      '>>>>>>> branch',
    ].join('\n');
    const [block] = findConflictBlocks(text);
    expect(block).toMatchObject({ start: 1, base: 3, sep: 5, end: 7 });
    expect(applyConflictChoice(text, block, 'both')).toBe('ours\ntheirs');
  });

  it('returns no blocks for text without markers', () => {
    expect(findConflictBlocks('plain\ntext\nonly')).toEqual([]);
  });

  it('skips a start marker that never closes', () => {
    expect(findConflictBlocks('<<<<<<< HEAD\nours\nno end here')).toEqual([]);
  });

  it('matches markers in CRLF buffers', () => {
    const text = '<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> b\r\n';
    const [block] = findConflictBlocks(text);
    expect(block).toMatchObject({ start: 1, sep: 3, end: 5 });
  });
});

describe('applyConflictChoice', () => {
  const block = findConflictBlocks(SIMPLE)[0];

  it('accepts the current (ours) side', () => {
    expect(applyConflictChoice(SIMPLE, block, 'current')).toBe(
      'before\nours line\nafter',
    );
  });

  it('accepts the incoming (theirs) side', () => {
    expect(applyConflictChoice(SIMPLE, block, 'incoming')).toBe(
      'before\ntheirs line\nafter',
    );
  });

  it('accepts both sides, current first', () => {
    expect(applyConflictChoice(SIMPLE, block, 'both')).toBe(
      'before\nours line\ntheirs line\nafter',
    );
  });

  it('is a no-op when the block no longer matches the text', () => {
    const edited = SIMPLE.replace('<<<<<<< HEAD', 'resolved already');
    expect(applyConflictChoice(edited, block, 'current')).toBe(edited);
  });

  it('preserves CRLF content lines', () => {
    const text = 'a\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> b\r\nz';
    const [b] = findConflictBlocks(text);
    expect(applyConflictChoice(text, b, 'incoming')).toBe('a\r\ntheirs\r\nz');
  });
});
