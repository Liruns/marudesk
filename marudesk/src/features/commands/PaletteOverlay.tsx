import { useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useFocusTrap } from '../../hooks/useFocusTrap';

/**
 * The shared keyboard-overlay shell behind every command palette — the ⌘K command
 * palette, the Flight Log, Quick Open (Ctrl+P), the Tab switcher, and the model
 * picker. It owns the one true chrome so the five surfaces stop drifting apart:
 *
 * - a `fixed inset-0` centered container that is the `role="dialog" aria-modal`
 *   boundary (the aria-label is supplied per palette);
 * - ONE scrim — an `aria-hidden tabIndex={-1}` button (NOT a focusable close
 *   control, so the first Tab lands on real content) that dismisses on click;
 * - ONE card treatment (rounded-xl, bordered, lifted) at ONE top offset;
 * - a single Escape handler so every palette dismisses the same way;
 * - an UNCONDITIONAL focus trap (`role="dialog" aria-modal` promises focus stays
 *   inside): Tab/Shift+Tab cycle within the card and focus restores to the trigger
 *   on close. The trap focuses the first focusable on open — which for the search
 *   palettes is the same input they also rAF-/autofocus, so the two agree (the
 *   input wins either way and there is no visible focus fight).
 *
 * Palettes keep their own `max-width`, their input/list content, and their own
 * filtering/selection logic — this only standardises the frame.
 */
export function PaletteOverlay({
  ariaLabel,
  onClose,
  className,
  children,
}: {
  /** The dialog's accessible name (e.g. 'Command palette', 'Search tabs'). */
  ariaLabel: string;
  onClose: () => void;
  /** Card width override + any palette-specific layout (defaults to a roomy max-w-xl). */
  className?: string;
  children: ReactNode;
}) {
  // Escape always dismisses, regardless of where focus sits. Palettes that also
  // handle Escape inside their input (to preventDefault) keep doing so; this is
  // the backstop for focus that has moved off the input (e.g. onto a row).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/30"
        onClick={onClose}
      />
      <PaletteCard className={className}>{children}</PaletteCard>
    </div>
  );
}

function PaletteCard({ className, children }: { className?: string; children: ReactNode }) {
  // Always trap focus: the dialog is `aria-modal`, so Tab must never escape onto
  // the chrome behind the dimmed scrim. The hook focuses the first focusable on
  // open (the search input for every palette that has one — the same element the
  // palette also rAF-/autofocuses, so they agree) and restores focus to the
  // trigger on unmount.
  const cardRef = useFocusTrap<HTMLDivElement>();
  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      className={cn(
        'relative mx-4 mt-[12vh] flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden',
        'rounded-xl border border-default bg-surface-1 shadow-lifted animate-scale-in',
        'focus:outline-none',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The keycap chip used in every palette's hint footer (↑↓ / ↵ / esc). */
export function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded bg-surface-3 px-1 text-kbd font-medium text-fg-secondary">
        {k}
      </kbd>
      <span>{label}</span>
    </span>
  );
}

/** The hint footer row that anchors a palette's keyboard legend. */
export function PaletteHints({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-t border-subtle px-3 py-1.5 text-caption text-fg-tertiary">
      {children}
    </div>
  );
}
