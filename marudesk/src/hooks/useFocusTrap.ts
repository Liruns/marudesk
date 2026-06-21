import { useEffect, useRef } from 'react';

/**
 * Keyboard focus management for a modal overlay. On mount it captures the
 * previously focused element, moves focus into the dialog (the first focusable
 * descendant, or the container itself), and traps Tab / Shift+Tab so focus
 * cycles within the card instead of escaping to the chrome behind the backdrop.
 * On unmount it restores focus to wherever it was when the modal opened (e.g.
 * the trigger button), so keyboard users land back where they started.
 *
 * Returns a ref to attach to the dialog container. Give that container
 * `tabIndex={-1}` so it can hold focus when it has no focusable children yet.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );

    // Move focus into the dialog: first interactive control, else the container.
    const first = focusable()[0];
    (first ?? container).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        // Nothing tabbable inside — keep focus pinned to the container.
        e.preventDefault();
        container.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === firstItem || active === container) {
          e.preventDefault();
          lastItem.focus();
        }
      } else if (active === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return ref;
}
