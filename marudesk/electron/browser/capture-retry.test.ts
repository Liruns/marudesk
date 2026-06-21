import { describe, expect, it, vi } from 'vitest';
import type { NativeImage } from 'electron';
import { captureWithRetry } from './capture-retry.ts';

/**
 * The retry policy is exercised with stub captures and a no-op delay so the
 * suite needs neither Electron nor real timers. We model a NativeImage as a tiny
 * tagged object and supply our own `isEmpty` predicate over it.
 */

interface FakeImage {
  readonly empty: boolean;
  readonly tag: string;
}

// captureWithRetry only ever passes the value straight to `isEmpty` / returns
// it, so a structural stand-in is sufficient for the policy under test.
const asImage = (img: FakeImage): NativeImage => img as unknown as NativeImage;
const real: FakeImage = { empty: false, tag: 'real' };
const blank: FakeImage = { empty: true, tag: 'blank' };

const isEmpty = (img: NativeImage): boolean =>
  (img as unknown as FakeImage).empty;

// Never actually wait — assert the backoff is consulted without real time.
const noDelay = (): Promise<void> => Promise.resolve();

describe('captureWithRetry', () => {
  it('recovers when the first attempt rejects then succeeds', async () => {
    const capture = vi
      .fn<() => Promise<NativeImage>>()
      .mockRejectedValueOnce(new Error('UnknownVizError'))
      .mockResolvedValueOnce(asImage(real));

    const result = await captureWithRetry({ capture, isEmpty, delay: noDelay });

    expect(result).toBe(asImage(real));
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('recovers when the first frame is empty then a real image paints', async () => {
    const capture = vi
      .fn<() => Promise<NativeImage>>()
      .mockResolvedValueOnce(asImage(blank))
      .mockResolvedValueOnce(asImage(real));

    const result = await captureWithRetry({ capture, isEmpty, delay: noDelay });

    expect(result).toBe(asImage(real));
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('returns null without throwing when every attempt rejects', async () => {
    const capture = vi
      .fn<() => Promise<NativeImage>>()
      .mockRejectedValue(new Error('UnknownVizError'));

    const result = await captureWithRetry({ capture, isEmpty, delay: noDelay });

    expect(result).toBeNull();
    // Default schedule is [50,100,200] → 4 total attempts.
    expect(capture).toHaveBeenCalledTimes(4);
  });

  it('returns null when every frame is empty', async () => {
    const capture = vi
      .fn<() => Promise<NativeImage>>()
      .mockResolvedValue(asImage(blank));

    const result = await captureWithRetry({ capture, isEmpty, delay: noDelay });

    expect(result).toBeNull();
    expect(capture).toHaveBeenCalledTimes(4);
  });

  it('honors a custom backoff length for the attempt budget', async () => {
    const capture = vi
      .fn<() => Promise<NativeImage>>()
      .mockResolvedValue(asImage(blank));
    const delays: number[] = [];

    const result = await captureWithRetry({
      capture,
      isEmpty,
      backoff: [10],
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(result).toBeNull();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([10]);
  });
});
