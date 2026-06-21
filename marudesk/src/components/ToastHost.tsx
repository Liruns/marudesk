import { useToastStore } from '../lib/toast';
import { cn } from '../lib/cn';
import { Toast } from './ui';

/**
 * Renders the live toast queue. Mounted once in the Shell. Anchored to the
 * window's bottom-right, above the chrome; `pointer-events-none` on the stack
 * lets clicks pass through the gaps while each toast stays interactive.
 *
 * Each toast rides the shared `fade-rise` entrance (200ms, single easing) and
 * pauses its auto-dismiss countdown while the pointer is over it, so a notice
 * never slides away mid-read (DESIGN.md §4 — "pause on hover"). On dismissal it
 * plays `toast-out` in place (the store keeps it mounted, flagged `leaving`,
 * for the exit duration) and goes non-interactive so it can't be re-triggered.
 */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const pause = useToastStore((s) => s.pause);
  const resume = useToastStore((s) => s.resume);
  // Stacking order: toast (z-[70]) > palette scrim (z-[60]) > content; Tour (z-[100]) still wins.
  // The container stays mounted even when empty so the toasts render inside an
  // already-present region — several screen readers only announce content that
  // changes inside a live region that existed beforehand. Per-toast politeness
  // (status vs alert) is set on the Toast itself.
  return (
    <div className="fixed bottom-3 right-3 z-[70] flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            t.leaving ? 'pointer-events-none animate-toast-out' : 'pointer-events-auto animate-fade-rise',
          )}
          aria-hidden={t.leaving ? true : undefined}
          onMouseEnter={t.leaving ? undefined : () => pause(t.id)}
          onMouseLeave={t.leaving ? undefined : () => resume(t.id)}
        >
          <Toast
            title={t.title}
            description={t.description}
            variant={t.variant}
            onDismiss={t.leaving ? undefined : () => dismiss(t.id)}
          />
        </div>
      ))}
    </div>
  );
}
