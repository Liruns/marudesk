import { describe, expect, it } from 'vitest';
import { transcriptWindow } from './useStickyTranscriptScroll';

/**
 * Pure math behind the transcript's bounded mounted-scrollback. The window is
 * always the TAIL of the row list (the live edge is never hidden); `reveal` and
 * `forceMin` only ever widen it toward the top. These cases pin the invariant
 * the whole feature rests on: hiddenCount === start, and start + visible == total.
 */
describe('transcriptWindow', () => {
  it('mounts every row when total is at or below the cap', () => {
    expect(transcriptWindow(50, 120, 120)).toEqual({ start: 0, hiddenCount: 0 });
    expect(transcriptWindow(120, 120, 120)).toEqual({ start: 0, hiddenCount: 0 });
  });

  it('hides the oldest rows once total exceeds the cap', () => {
    // 300 rows, cap 120 → mount the last 120, hide the first 180.
    expect(transcriptWindow(300, 120, 120)).toEqual({ start: 180, hiddenCount: 180 });
  });

  it('keeps the live edge mounted: start + visible always equals total', () => {
    const total = 500;
    const { start } = transcriptWindow(total, 120, 120);
    const visible = total - start;
    expect(start + visible).toBe(total);
    expect(visible).toBe(120);
  });

  it('reveal widens the mounted tail toward the top', () => {
    // One "Load earlier" click adds another cap's worth.
    expect(transcriptWindow(300, 120, 240)).toEqual({ start: 60, hiddenCount: 60 });
    // Revealing past the total clamps to "everything mounted".
    expect(transcriptWindow(300, 120, 1000)).toEqual({ start: 0, hiddenCount: 0 });
  });

  it('forceMin pins a minimum visible count for a search jump', () => {
    // A jump to row 10 of 300 needs the last 290 rows mounted even though the
    // user has not revealed anything; forceMin guarantees it.
    expect(transcriptWindow(300, 120, 120, 290)).toEqual({ start: 10, hiddenCount: 10 });
    // forceMin below the current window is a no-op (the wider reveal wins).
    expect(transcriptWindow(300, 120, 240, 50)).toEqual({ start: 60, hiddenCount: 60 });
  });

  it('takes the max of cap, reveal, and forceMin', () => {
    expect(transcriptWindow(300, 120, 200, 250)).toEqual({ start: 50, hiddenCount: 50 });
  });

  it('never produces a negative start', () => {
    expect(transcriptWindow(5, 120, 120).start).toBe(0);
    expect(transcriptWindow(0, 120, 120)).toEqual({ start: 0, hiddenCount: 0 });
  });

  it('treats a non-positive cap as windowing disabled (mount everything)', () => {
    expect(transcriptWindow(300, 0, 0)).toEqual({ start: 0, hiddenCount: 0 });
  });
});
