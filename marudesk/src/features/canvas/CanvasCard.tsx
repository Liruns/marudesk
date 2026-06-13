import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ExternalLink, Globe, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { tabKinds } from '../tabs/registry';
import type { CardRect } from './store';
import type { TabState } from '../../../shared/browser';

/**
 * One card on the infinite canvas: a draggable / resizable frame whose body is a
 * tab's surface, resolved through the shared `tabKinds` registry (so editor,
 * terminal, agent, home, settings render exactly as they do in a pane). Web cards
 * render an empty measured surface the main process composites the live
 * WebContentsView over.
 *
 * Frame controls (connection port + resize handles) sit on the card frame just
 * OUTSIDE the body — the root is not `overflow-hidden`, the body clips itself —
 * so they stay clickable on web cards (clear of the native view). They fade in on
 * hover / focus (Figma-style). Pointer math: the plane is CSS-scaled, so a
 * screen-px delta is divided by `scale` to get the canvas-space delta.
 */
type ResizeDir = 'e' | 's' | 'se';

export function CanvasCard({
  tab,
  rect,
  scale,
  focused,
  onFocus,
  onClose,
  onMove,
  onNudge,
  onResize,
  registerWebEl,
  onNavigate,
  onOpenDevtools,
  onStartConnect,
}: {
  tab: TabState;
  rect: CardRect;
  scale: number;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
  /** Keyboard move (no snap), so arrow-nudge stays precise. Falls back to onMove. */
  onNudge?: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  registerWebEl?: (el: HTMLDivElement | null) => void;
  onNavigate?: (input: string) => void;
  onOpenDevtools?: () => void;
  onStartConnect?: (clientX: number, clientY: number) => void;
}) {
  const isWeb = tab.kind === 'web';
  const rootRef = useRef<HTMLDivElement>(null);
  const [addr, setAddr] = useState(tab.url);
  const addrFocused = useRef(false);
  useEffect(() => {
    if (!addrFocused.current) setAddr(tab.url);
  }, [tab.url]);
  const Icon = tabKinds[tab.kind]?.icon ?? Globe;
  const title = tab.title?.trim() || tab.url || tabKinds[tab.kind]?.title || 'Card';
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeState = useRef<{ pointerId: number; startX: number; startY: number; origW: number; origH: number; dir: ResizeDir } | null>(null);

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus();
    rootRef.current?.focus(); // so arrow-nudge / Delete work after a click
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origX: rect.x, origY: rect.y };
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (!s || s.pointerId !== e.pointerId) return;
    onMove(s.origX + (e.clientX - s.startX) / scale, s.origY + (e.clientY - s.startY) / scale);
  };
  const onHeaderPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId === e.pointerId) dragState.current = null;
  };

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus();
    e.currentTarget.setPointerCapture(e.pointerId);
    const dir = (e.currentTarget.dataset.resizeDir as ResizeDir | undefined) ?? 'se';
    resizeState.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origW: rect.w, origH: rect.h, dir };
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = resizeState.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dw = (e.clientX - s.startX) / scale;
    const dh = (e.clientY - s.startY) / scale;
    onResize(s.dir === 's' ? s.origW : s.origW + dw, s.dir === 'e' ? s.origH : s.origH + dh);
  };
  const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeState.current?.pointerId === e.pointerId) resizeState.current = null;
  };

  // Keyboard, only when the card FRAME itself is focused (not a child surface):
  // arrows nudge (Shift = 1px), Delete/Backspace closes. Focus reaches the frame
  // by Tab or by clicking the header (which calls .focus() below).
  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const step = e.shiftKey ? 1 : 8;
    const move = onNudge ?? onMove; // free placement for keyboard (no snap)
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      move(rect.x - step, rect.y);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      move(rect.x + step, rect.y);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(rect.x, rect.y - step);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(rect.x, rect.y + step);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onClose();
    }
  };

  // Frame controls fade in on hover; stay visible while the card is focused.
  const reveal = focused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';

  return (
    <div
      ref={rootRef}
      data-canvas-card
      data-tab-id={tab.id}
      role="group"
      aria-label={`${title} card`}
      tabIndex={0}
      className={cn(
        'group @container absolute flex flex-col rounded-lg chrome-panel transition-shadow duration-fast',
        focused ? 'ring-1 ring-accent/60 shadow-lifted' : 'shadow-card hover:shadow-lifted',
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: rect.z }}
      onPointerDown={onFocus}
      onKeyDown={onRootKeyDown}
    >
      <div
        data-card-header
        className={cn(
          'flex items-center h-9 shrink-0 cursor-grab active:cursor-grabbing select-none',
          'gap-1 px-1.5 @[20rem]:gap-2 @[20rem]:px-2.5',
          'rounded-t-lg border-b border-subtle bg-surface-2',
        )}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span className="shrink-0 text-fg-tertiary">
          <Icon size={14} />
        </span>
        {isWeb ? (
          <input
            value={addr}
            spellCheck={false}
            placeholder="Search or enter address"
            aria-label="Address"
            className={cn(
              'flex-1 min-w-0 bg-transparent text-caption text-fg-secondary',
              'placeholder:text-fg-tertiary focus:outline-none',
            )}
            onChange={(e) => setAddr(e.target.value)}
            onFocus={() => {
              addrFocused.current = true;
            }}
            onBlur={() => {
              addrFocused.current = false;
              setAddr(tab.url);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const v = addr.trim();
                if (v) onNavigate?.(v);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        ) : (
          <span className="flex-1 min-w-0 truncate text-caption text-fg-secondary">{title}</span>
        )}
        {isWeb && onOpenDevtools ? (
          <button
            type="button"
            aria-label="Open DevTools"
            title="Open DevTools"
            className="hidden @[20rem]:grid place-items-center h-6 w-6 rounded text-fg-tertiary transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenDevtools();
            }}
          >
            <ExternalLink size={13} />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Close card"
          className="grid place-items-center h-6 w-6 rounded text-fg-tertiary transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X size={14} />
        </button>
      </div>

      <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden rounded-b-lg bg-surface-page">
        {isWeb ? (
          <div ref={registerWebEl} className="relative h-full w-full bg-surface-1" aria-label="Web card">
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <Globe size={22} className="text-fg-tertiary" aria-hidden />
              <p className="max-w-full truncate text-body text-fg-secondary">{title}</p>
              {tab.url ? (
                <p className="max-w-full truncate text-caption text-fg-tertiary">{tab.url}</p>
              ) : null}
            </div>
          </div>
        ) : (
          tabKinds[tab.kind].render(tab.id, tab)
        )}
      </div>

      {/* Connection port (right-center, just outside the body). */}
      {onStartConnect ? (
        <button
          type="button"
          aria-label="Connect to another card"
          title="Drag to another card to connect"
          className={cn(
            // Above the resize handles (z-10) so it wins the right-edge overlap.
            'absolute top-1/2 -right-2 z-20 h-3.5 w-3.5 -translate-y-1/2 rounded-pill transition-opacity duration-fast',
            'border border-accent bg-surface-1 hover:bg-accent cursor-crosshair',
            reveal,
          )}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            onStartConnect(e.clientX, e.clientY);
          }}
        />
      ) : null}

      {/* Resize handles — width (E), height (S), both (SE). Transparent hit
          strips on the frame edges (clear of the native web view); the corner
          shows a grip on hover/focus. */}
      <div
        aria-hidden
        data-resize-dir="e"
        className="absolute top-9 -right-1 bottom-3 z-10 w-2 cursor-ew-resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />
      <div
        aria-hidden
        data-resize-dir="s"
        className="absolute -bottom-1 left-3 right-3 z-10 h-2 cursor-ns-resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />
      <div
        role="separator"
        aria-label="Resize card"
        data-resize-dir="se"
        className="absolute -bottom-1.5 -right-1.5 z-10 h-5 w-5 cursor-nwse-resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      >
        <span
          aria-hidden
          className={cn(
            'absolute bottom-2 right-2 h-2 w-2 border-b-2 border-r-2 border-strong transition-opacity duration-fast',
            reveal,
          )}
        />
      </div>
    </div>
  );
}
