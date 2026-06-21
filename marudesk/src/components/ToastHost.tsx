import { useToastStore } from '../lib/toast';
import { Toast } from './ui';

/**
 * Renders the live toast queue. Mounted once in the Shell. Anchored to the
 * window's bottom-right, above the chrome; `pointer-events-none` on the stack
 * lets clicks pass through the gaps while each toast stays interactive.
 *
 * Each toast rides the shared `fade-rise` entrance (200ms, single easing) and
 * pauses its auto-dismiss countdown while the pointer is over it, so a notice
 * never slides away mid-read (DESIGN.md §4 — "pause on hover").
 */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const pause = useToastStore((s) => s.pause);
  const resume = useToastStore((s) => s.resume);
  if (toasts.length === 0) return null;
  // Stacking order: toast (z-[70]) > palette scrim (z-[60]) > content; Tour (z-[100]) still wins.
  return (
    <div className="fixed bottom-3 right-3 z-[70] flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto animate-fade-rise"
          onMouseEnter={() => pause(t.id)}
          onMouseLeave={() => resume(t.id)}
        >
          <Toast
            title={t.title}
            description={t.description}
            variant={t.variant}
            onDismiss={() => dismiss(t.id)}
          />
        </div>
      ))}
    </div>
  );
}
