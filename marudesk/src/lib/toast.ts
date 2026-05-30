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
};

type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Auto-dismiss after this many ms; 0 keeps it until dismissed. */
  durationMs?: number;
};

type ToastStore = {
  toasts: ToastItem[];
  push: (input: ToastInput) => number;
  dismiss: (id: number) => void;
};

let seq = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: ({ title, description, variant = 'neutral', durationMs = 3500 }) => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, title, description, variant }] }));
    if (durationMs > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, durationMs);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative helper for non-component code (stores, event handlers). */
export function toast(input: ToastInput): number {
  return useToastStore.getState().push(input);
}
