import type { Unsubscribe } from './types';

/** Tiny typed multi-subscriber emitter shared by the transports. */
export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  private last: T | undefined;

  /** Subscribe. If a value was already emitted, the new listener gets it immediately. */
  subscribe(cb: (value: T) => void): Unsubscribe {
    this.listeners.add(cb);
    if (this.last !== undefined) cb(this.last);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(value: T): void {
    this.last = value;
    for (const cb of this.listeners) cb(value);
  }

  /** Drop all subscribers (used on disconnect/dispose). */
  clear(): void {
    this.listeners.clear();
  }
}
