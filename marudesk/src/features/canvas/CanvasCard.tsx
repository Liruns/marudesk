import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ExternalLink, Globe, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { tabKinds } from '../tabs/registry';
import type { CardRect } from './store';
import type { TabState } from '../../../shared/browser';

/**
 * One card on the infinite canvas: a draggable / resizable frame whose body is a
 * tab's surface, resolved through the shared `tabKinds` registry (so editor,
 * terminal, agent, home, settings render exactly as they do in a pane). Web cards
 * render an empty measured surface that the main process composites the live
 * WebContentsView over.
 *
 * Because a native web view composites OVER the React body, the resize handle and
 * the connection port live on the card frame just OUTSIDE the body (the root is
 * not `overflow-hidden`; the body clips itself), so they stay clickable on web
 * cards. Pointer math: the plane is CSS-scaled, so a screen-px delta is divided
 * by `scale` to get the canvas-space delta for move/resize.
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
  onResize: (w: number, h: number) => void;
  registerWebEl?: (el: HTMLDivElement | null) => void;
  onNavigate?: (input: string) => void;
  onOpenDevtools?: () => void;
  /** Begin dragging a connection from this card (screen coords of the pointer). */
  onStartConnect?: (clientX: number, clientY: number) => void;
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
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeState = useRef<{ pointerId: number; startX: number; startY: number; origW: number; origH: number } | null>(null);

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus();
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

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeState.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origW: rect.w, origH: rect.h };
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
      data-tab-id={tab.id}
      className={cn(
        'absolute flex flex-col rounded-lg chrome-panel transition-shadow duration-fast',
        focused ? 'ring-1 ring-accent/50 shadow-lifted' : 'shadow-card',
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: rect.z }}
      onPointerDown={onFocus}
    >
      {/* Header: drag handle + title/omnibox + actions. */}
      <div
        className={cn(
          'flex items-center gap-2 h-9 shrink-0 px-2.5 cursor-grab active:cursor-grabbing select-none',
          'rounded-t-lg border-b border-subtle bg-surface-2',
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
            className="grid place-items-center h-6 w-6 rounded hover:bg-surface-3 text-fg-tertiary hover:text-fg-primary"
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

      {/* Body. Clips itself (the root is not overflow-hidden so the frame
          controls can sit just outside it). Web cards render an empty measured
          surface the main process composites the live WebContentsView over. */}
      <div className="relative flex-1 min-h-0 overflow-hidden rounded-b-lg bg-surface-page">
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

      {/* Connection port (right-center, just outside the body). Drag to another
          card to wire them together. */}
      {onStartConnect ? (
        <button
          type="button"
          aria-label="Connect to another card"
          title="Drag to another card to connect"
          className={cn(
            'absolute top-1/2 -right-2 z-10 h-3.5 w-3.5 -translate-y-1/2 rounded-pill',
            'border border-accent bg-surface-1 hover:bg-accent cursor-crosshair',
          )}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            onStartConnect(e.clientX, e.clientY);
          }}
        />
      ) : null}

      {/* Resize handle (bottom-right). Sits just outside the body corner so it
          stays clickable on web cards (clear of the native view); pointer capture
          keeps the drag alive once it moves over the view. */}
      <div
        role="separator"
        aria-label="Resize card"
        className="absolute -bottom-1.5 -right-1.5 z-10 h-5 w-5 cursor-nwse-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
      >
        <span aria-hidden className="absolute bottom-2 right-2 h-2 w-2 border-b-2 border-r-2 border-strong" />
      </div>
    </div>
  );
}
