import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Globe, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { tabKinds } from '../tabs/registry';
import type { CardRect } from './store';
import type { TabState } from '../../../shared/browser';

/**
 * One card on the infinite canvas: a draggable / resizable frame whose body is a
 * tab's surface, resolved through the shared `tabKinds` registry (so editor,
 * terminal, agent, home, settings all render exactly as they do in a pane). Web
 * cards show a placeholder in Phase 2A — the live WebContentsView is composited
 * onto the canvas in Phase 2B (see docs/maru-identity-and-canvas-design.md).
 *
 * Pointer math: the canvas plane is CSS-scaled, so a pointer delta in screen px
 * is divided by `scale` to get the canvas-space delta for move/resize.
 */
export function CanvasCard({
  tab,
  rect,
  scale,
  focused,
  onFocus,
  onClose,
  onMove,
  onResize,
  registerWebEl,
  onNavigate,
}: {
  tab: TabState;
  rect: CardRect;
  scale: number;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (w: number, h: number) => void;
  /**
   * For web cards: receives the body element so the canvas can measure its
   * (post-transform) screen rect and position the native WebContentsView there
   * via the shared pane-bounds pipeline. Undefined for feature cards.
   */
  registerWebEl?: (el: HTMLDivElement | null) => void;
  /** For web cards: navigate this card's tab to a URL / search term. */
  onNavigate?: (input: string) => void;
}) {
  const isWeb = tab.kind === 'web';
  // Web-card address bar: a controlled input seeded from the tab's URL, kept in
  // sync with navigations (but never while the user is editing it).
  const [addr, setAddr] = useState(tab.url);
  const addrFocused = useRef(false);
  useEffect(() => {
    if (!addrFocused.current) setAddr(tab.url);
  }, [tab.url]);
  const Icon = tabKinds[tab.kind]?.icon ?? Globe;
  const title = tab.title?.trim() || tab.url || tabKinds[tab.kind]?.title || 'Card';
  const dragState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const resizeState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.x,
      origY: rect.y,
    };
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (!s || s.pointerId !== e.pointerId) return;
    onMove(s.origX + (e.clientX - s.startX) / scale, s.origY + (e.clientY - s.startY) / scale);
  };
  const onHeaderPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId === e.pointerId) dragState.current = null;
  };

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origW: rect.w,
      origH: rect.h,
    };
  };
  const onResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = resizeState.current;
    if (!s || s.pointerId !== e.pointerId) return;
    onResize(s.origW + (e.clientX - s.startX) / scale, s.origH + (e.clientY - s.startY) / scale);
  };
  const onResizePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeState.current?.pointerId === e.pointerId) resizeState.current = null;
  };

  return (
    <div
      data-canvas-card
      className={cn(
        'absolute flex flex-col overflow-hidden rounded-lg chrome-panel transition-shadow duration-fast',
        focused ? 'ring-1 ring-accent/50 shadow-lifted' : 'shadow-card',
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: rect.z }}
      onPointerDown={onFocus}
    >
      {/* Header: drag handle + title + close. */}
      <div
        className={cn(
          'flex items-center gap-2 h-9 shrink-0 px-2.5 cursor-grab active:cursor-grabbing select-none',
          'border-b border-subtle bg-surface-2',
        )}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <Icon size={14} />
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
            // Don't let a click/drag in the field start a card drag.
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
        <button
          type="button"
          aria-label="Close card"
          className="grid place-items-center h-6 w-6 rounded hover:bg-surface-3 text-fg-tertiary hover:text-fg-primary"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Body. Web cards render an empty measured surface — the live
          WebContentsView is composited over it by the main process (positioned
          from this element's screen rect). Feature cards render their real
          React surface from the shared registry. */}
      <div className="relative flex-1 min-h-0 bg-surface-page">
        {isWeb ? (
          <div ref={registerWebEl} className="relative h-full w-full bg-surface-1" aria-label="Web card">
            {/* Fallback shown only when the native web view isn't composited over
                this card (e.g. while it loads); the live page covers it once the
                main process positions the view at this element's rect. */}
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

      {/* Resize handle (bottom-right). Hidden on web cards: the native view
          composites over this corner and would swallow the pointer, so web
          cards move via the header and resize is a follow-up. */}
      {isWeb ? null : (
        <div
          role="separator"
          aria-label="Resize card"
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
        >
          <span aria-hidden className="absolute bottom-1 right-1 h-2 w-2 border-b-2 border-r-2 border-strong" />
        </div>
      )}
    </div>
  );
}
