import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

export type MenuItem =
  | { type: 'separator' }
  | {
      type?: 'item';
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      icon?: ReactNode;
      shortcut?: string;
      checked?: boolean;
    };

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

/**
 * Cursor-anchored popup menu, portaled to <body> and clamped into the viewport.
 * Dismisses on outside pointer-down, Esc, scroll, blur, or resize. Arrow keys
 * move between enabled items; Enter/click selects (then closes).
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    // Snapshot the trigger so keyboard/SR users land back where they started
    // when the menu closes (Esc or item select), instead of dropping to <body>.
    // Mirrors useFocusTrap: capture on mount, restore once on unmount.
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const first = ref.current?.querySelector<HTMLButtonElement>(
      'button[data-mi]:not([disabled])',
    );
    // Focus without scrolling: a scroll-into-view here would trip the
    // close-on-scroll guard below (the menu would dismiss itself on open).
    first?.focus({ preventScroll: true });
    return () => {
      trigger?.focus({ preventScroll: true });
    };
  }, []);

  // A WebContentsView composites ABOVE the React DOM, so a menu over a web view
  // would render *behind* the page. Report the exact screen rect the menu covers;
  // main hides only the web views that actually intersect it — precise, not a
  // blanket hide-all (which blanked every card on a canvas full of web cards).
  // offsetWidth/Height (not getBoundingClientRect) ignores the scale-in transform.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    void window.marudesk.invoke('browser:set-occluder', {
      x: pos.x,
      y: pos.y,
      width: el.offsetWidth,
      height: el.offsetHeight,
    });
    return () => {
      void window.marudesk.invoke('browser:set-occluder', null);
    };
  }, [pos.x, pos.y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onScroll = () => onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>(
        'button[data-mi]:not([disabled])',
      ) ?? [],
    );
    if (btns.length === 0) return;
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? (idx + 1) % btns.length
        : (idx - 1 + btns.length) % btns.length;
    btns[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onKeyDown={onMenuKeyDown}
      style={{ left: pos.x, top: pos.y }}
      className={cn(
        'fixed z-50 min-w-[216px] overflow-hidden rounded-lg animate-scale-in',
        'bg-surface-2 bg-surface-gradient shadow-menu',
        'py-1',
        'text-body-sm text-fg-primary',
      )}
    >
      <div className="px-1">
        {items.map((item, i) =>
          'type' in item && item.type === 'separator' ? (
            <div key={`sep-${i}`} className="my-1 -mx-1 h-px bg-border-subtle" />
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              data-mi
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                onClose();
              }}
              className={cn(
                'w-full flex items-center gap-2 px-2 h-7 rounded-md text-left outline-none',
                'transition-colors duration-fast',
                item.disabled
                  ? 'text-fg-disabled cursor-not-allowed'
                  : item.danger
                    ? 'text-error hover:bg-error-subtle/60 focus:bg-error-subtle/60'
                    : 'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary focus:bg-surface-3 focus:text-fg-primary',
              )}
            >
              {item.icon ? (
                <span className="size-4 shrink-0 flex items-center justify-center opacity-70">
                  {item.icon}
                </span>
              ) : (
                <span className="size-4 shrink-0" aria-hidden />
              )}
              <span className="flex-1 min-w-0 truncate">{item.label}</span>
              {item.shortcut ? (
                <span className="ml-4 text-caption text-fg-quaternary tabular-nums shrink-0">
                  {item.shortcut}
                </span>
              ) : null}
              {item.checked !== undefined ? (
                item.checked ? (
                  <Check size={12} className="shrink-0 text-accent" aria-hidden />
                ) : (
                  <span className="size-3 shrink-0" aria-hidden />
                )
              ) : null}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
