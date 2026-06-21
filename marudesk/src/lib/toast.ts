import { create } from 'zustand';

/**
 * A tiny transient-notification store. The `<Toast>` UI component already
 * existed; this adds the queue + auto-dismiss behind it, rendered by
 * `<ToastHost>` (mounted once in the Shell). Used for feedback that has no
 * natural home in the layout — e.g. "exit the grid to use DevTools", or a
 * one-off DevTools error.
 *
 * Note: toasts anchor to the window's bottom-right. The embedded WebContentsView
 * composites above the React DOM, so a toast over the live web stage can be
 * occluded; in practice the DevTools cases fire with the (React) dock open, so
 * the corner sits over the dock and stays visible.
 */

export type ToastVariant = 'neutral' | 'success' | 'warning' | 'error';

export type ToastItem = {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  /** Resolved auto-dismiss budget in ms (0 = sticky). Kept for the resume math. */
  durationMs: number;
  /** True while the toast plays its exit animation, just before removal. The
   *  host applies `animate-toast-out` and drops interactivity when set. */
  leaving?: boolean;
};

type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms; 0 keeps it until dismissed. Omit to use
   *  the variant default (errors linger longer). */
  durationMs?: number;
};

type ToastStore = {
  toasts: ToastItem[];
  push: (input: ToastInput) => number;
  dismiss: (id: number) => void;
  /** Freeze a toast's auto-dismiss countdown (used while the pointer hovers). */
  pause: (id: number) => void;
  /** Resume a paused countdown from the time that was left when it paused. */
  resume: (id: number) => void;
};

let seq = 0;

// Per-toast dismiss timers, tracked outside React state so hover can pause and
// resume them without re-rendering the queue. `deadline` lets resume() recover
// the time that was left at the moment the pointer entered.
type ToastTimer = { handle: ReturnType<typeof setTimeout>; deadline: number; remaining: number };
const timers = new Map<number, ToastTimer>();

// DESIGN.md §4 (Toast): 4500ms default, 10000ms for errors — an error is the
// one variant worth lingering on. Callers can still pass 0 to make it sticky.
function defaultDuration(variant: ToastVariant): number {
  return variant === 'error' ? 10000 : 4500;
}

// Matches the `--motion-fast` token driving `animate-toast-out` in
// tailwind.config.ts, so the store removes the toast exactly as the exit
// animation finishes.
const EXIT_MS = 120;

export const useToastStore = create<ToastStore>((set, get) => {
  const arm = (id: number, ms: number) => {
    if (ms <= 0) return;
    const handle = setTimeout(() => {
      timers.delete(id);
      get().dismiss(id);
    }, ms);
    timers.set(id, { handle, deadline: Date.now() + ms, remaining: ms });
  };
  return {
    toasts: [],
    push: ({ title, description, variant = 'neutral', durationMs }) => {
      const id = ++seq;
      const ms = durationMs ?? defaultDuration(variant);
      set((s) => ({
        toasts: [...s.toasts, { id, title, description, variant, durationMs: ms }],
      }));
      arm(id, ms);
      return id;
    },
    dismiss: (id) => {
      // Already leaving? The exit timer is running — leave it untouched so a
      // double-dismiss can't cancel the pending removal.
      if (get().toasts.find((x) => x.id === id)?.leaving) return;
      const t = timers.get(id);
      if (t) {
        clearTimeout(t.handle);
        timers.delete(id);
      }
      // Phase 1: flag the toast so the host plays the exit animation in place.
      set((s) => ({ toasts: s.toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x)) }));
      // Phase 2: drop it from the queue once the exit animation completes. The
      // handle rides the same `timers` map so a stray pause/resume is a no-op.
      const handle = setTimeout(() => {
        timers.delete(id);
        set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
      }, EXIT_MS);
      timers.set(id, { handle, deadline: Date.now() + EXIT_MS, remaining: EXIT_MS });
    },
    pause: (id) => {
      // A leaving toast owns the exit timer — never freeze that.
      if (get().toasts.find((x) => x.id === id)?.leaving) return;
      const t = timers.get(id);
      if (!t) return;
      clearTimeout(t.handle);
      timers.set(id, { ...t, remaining: Math.max(0, t.deadline - Date.now()) });
    },
    resume: (id) => {
      if (get().toasts.find((x) => x.id === id)?.leaving) return;
      const t = timers.get(id);
      if (!t) return;
      arm(id, t.remaining);
    },
  };
});

/** Imperative helper for non-component code (stores, event handlers). */
export function toast(input: ToastInput): number {
  return useToastStore.getState().push(input);
}
