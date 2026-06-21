import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from './toast';

describe('toast store — graceful exit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('flags a dismissed toast as leaving before removing it after the exit delay', () => {
    const id = useToastStore.getState().push({ title: 'Saved', durationMs: 0 });

    // Phase 1: dismiss marks the toast `leaving` but keeps it mounted so the
    // exit animation can play.
    useToastStore.getState().dismiss(id);
    const leaving = useToastStore.getState().toasts.find((t) => t.id === id);
    expect(leaving).toBeDefined();
    expect(leaving?.leaving).toBe(true);

    // Phase 2: the toast is gone (and its `leaving` flag with it) once the
    // exit timer fires.
    vi.advanceTimersByTime(200);
    expect(useToastStore.getState().toasts.find((t) => t.id === id)).toBeUndefined();
  });

  it('auto-dismiss routes through the same leaving → remove transition', () => {
    const id = useToastStore.getState().push({ title: 'Heads up', durationMs: 1000 });

    // Auto-dismiss fires: the toast should be flagged leaving, not yanked.
    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts.find((t) => t.id === id)?.leaving).toBe(true);

    // Then removed after the exit delay.
    vi.advanceTimersByTime(200);
    expect(useToastStore.getState().toasts.find((t) => t.id === id)).toBeUndefined();
  });

  it('a second dismiss on a leaving toast does not restart the exit timer', () => {
    const id = useToastStore.getState().push({ title: 'Once', durationMs: 0 });
    useToastStore.getState().dismiss(id);

    // Let part of the exit play, then dismiss again — it must still remove on
    // the original schedule, not reset.
    vi.advanceTimersByTime(60);
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts.find((t) => t.id === id)?.leaving).toBe(true);

    vi.advanceTimersByTime(60);
    expect(useToastStore.getState().toasts.find((t) => t.id === id)).toBeUndefined();
  });
});
