import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
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
    };

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /**
   * Marks the portaled root with `data-file-tree-context-menu-root` so when this
   * menu is rendered through `@pierre/trees`' `renderContextMenu` slot, the
   * library's outside-click detection treats clicks inside it as internal (the
   * menu portals to <body>, outside the tree's shadow root).
   */
  contextMenuRoot?: boolean;
};

/**
 * Cursor-anchored popup menu, portaled to <body> and clamped into the viewport.
 * Dismisses on outside pointer-down, Esc, scroll, blur, or resize. Arrow keys
 * move between enabled items; Enter/click selects (then closes).
 */
export function ContextMenu({ x, y, items, onClose, contextMenuRoot }: Props) {
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
    const first = ref.current?.querySelector<HTMLButtonElement>(
      'button[data-mi]:not([disabled])',
    );
    first?.focus();
  }, []);

  // A WebContentsView composites ABOVE the React DOM, so a menu opened over a
  // browser tab (e.g. the activity-bar gear) would otherwise render *behind* the
  // page. Hide the embedded view while the menu is open; restore on close. No-op
  // when the active tab owns no view (feature tabs / no web tab).
  useEffect(() => {
    void window.marudesk.invoke('browser:set-visible', false);
    return () => {
      void window.marudesk.invoke('browser:set-visible', true);
    };
  }, []);

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
      data-file-tree-context-menu-root={contextMenuRoot ? 'true' : undefined}
      onKeyDown={onMenuKeyDown}
      style={{ left: pos.x, top: pos.y }}
      className={cn(
        'chrome-popover fixed z-50 min-w-[200px] py-1 rounded animate-scale-in',
        'text-body-sm text-fg-primary',
      )}
    >
      {items.map((item, i) =>
        'type' in item && item.type === 'separator' ? (
          <div key={`sep-${i}`} className="my-1 h-px bg-surface-3" />
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
              'chrome-list-row w-full gap-2.5 px-3 h-7 text-left outline-none rounded-none',
              item.disabled
                ? 'text-fg-tertiary/50 cursor-not-allowed'
                : item.danger
                  ? 'text-error hover:bg-error-subtle focus:bg-error-subtle'
                  : 'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary focus:bg-surface-3 focus:text-fg-primary',
            )}
          >
            {item.icon ? (
              <span className="size-4 shrink-0 flex items-center justify-center text-fg-tertiary">
                {item.icon}
              </span>
            ) : (
              <span className="size-4 shrink-0" aria-hidden />
            )}
            <span className="flex-1 min-w-0 truncate">{item.label}</span>
            {item.shortcut ? (
              <span className="text-caption text-fg-tertiary tabular-nums">
                {item.shortcut}
              </span>
            ) : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
