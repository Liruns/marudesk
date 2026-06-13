import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ExternalLink, Globe, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { tabKinds } from '../tabs/registry';
import { EDGE_SIDES, type CardRect, type EdgeSide } from './store';
import type { TabState } from '../../../shared/browser';

/** A member of a merged card (tab group), for the in-header tab strip. */
export type CardGroupMember = { id: string; title: string; icon: ComponentType<{ size?: number }> };

export type CardGroupProps = {
  members: CardGroupMember[];
  activeId: string;
  onSelect: (tabId: string) => void;
  onCloseMember: (tabId: string) => void;
};

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

/** Where each face's connection port sits, centered just outside the frame. */
const PORT_POS: Record<EdgeSide, string> = {
  top: '-top-2 left-1/2 -translate-x-1/2',
  right: '-right-2 top-1/2 -translate-y-1/2',
  bottom: '-bottom-2 left-1/2 -translate-x-1/2',
  left: '-left-2 top-1/2 -translate-y-1/2',
};

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
  group,
  mergeHighlight,
  onHeaderDragMove,
  onHeaderDrop,
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
  onStartConnect?: (side: EdgeSide, clientX: number, clientY: number) => void;
  /** When set, the header is a tab strip of merged cards (this is a group). */
  group?: CardGroupProps;
  /** Highlight as a merge drop-target while another card is dragged over it. */
  mergeHighlight?: boolean;
  /** Header drag crossed the canvas — report screen coords for merge hit-testing. */
  onHeaderDragMove?: (clientX: number, clientY: number) => void;
  /** Header drag released — report the drop point so the stage can merge. */
  onHeaderDrop?: (clientX: number, clientY: number) => void;
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
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const resizeState = useRef<{ pointerId: number; startX: number; startY: number; origW: number; origH: number; dir: ResizeDir } | null>(null);

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus();
    rootRef.current?.focus(); // so arrow-nudge / Delete work after a click
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origX: rect.x, origY: rect.y, moved: false };
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (Math.abs(e.clientX - s.startX) > 3 || Math.abs(e.clientY - s.startY) > 3) s.moved = true;
    onMove(s.origX + (e.clientX - s.startX) / scale, s.origY + (e.clientY - s.startY) / scale);
    if (s.moved) onHeaderDragMove?.(e.clientX, e.clientY);
  };
  const onHeaderPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (s?.pointerId !== e.pointerId) return;
    if (s.moved) onHeaderDrop?.(e.clientX, e.clientY);
    dragState.current = null;
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
        mergeHighlight
          ? 'ring-2 ring-accent shadow-lifted'
          : focused
            ? 'ring-1 ring-accent/60 shadow-lifted'
            : 'shadow-card hover:shadow-lifted',
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
        {group ? (
          <GroupTabStrip group={group} />
        ) : (
          <>
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
          </>
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

      {/* flex flex-col so feature surfaces (terminal/editor/chat) that fill via
          `flex-1` get a definite height — the classic grid pane wraps them the
          same way. Without it the terminal host (`absolute inset-0`) collapses to
          0 height and renders blank. */}
      <div className="relative flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden rounded-b-lg bg-surface-page">
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

      {/* Connection ports — one per face (top/right/bottom/left), just outside
          the body so they clear a web card's native view. z-20 so each wins its
          overlap with the resize hit-strips (z-10). Drag a port onto another card
          to wire them; the port's side pins that end of the edge. */}
      {onStartConnect
        ? EDGE_SIDES.map((side) => (
            <button
              key={side}
              type="button"
              aria-label={`Connect from ${side} edge`}
              title="Drag to another card to connect"
              className={cn(
                'absolute z-20 h-3.5 w-3.5 rounded-pill transition-opacity duration-fast',
                'border border-accent bg-surface-1 hover:bg-accent cursor-crosshair',
                PORT_POS[side],
                reveal,
              )}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();
                onStartConnect(side, e.clientX, e.clientY);
              }}
            />
          ))
        : null}

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

/** The merged-card header: a horizontal strip of member tabs. Click to switch,
 *  × to close a member; the chips stop propagation so they don't start a drag. */
function GroupTabStrip({ group }: { group: CardGroupProps }) {
  return (
    <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto scrollbar-none">
      {group.members.map((m) => {
        const MIcon = m.icon;
        const active = m.id === group.activeId;
        return (
          <div
            key={m.id}
            role="tab"
            aria-selected={active}
            title={m.title}
            className={cn(
              'group/chip flex h-6 max-w-[10rem] shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-caption transition-colors duration-fast',
              active
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-tertiary hover:bg-surface-3/60 hover:text-fg-secondary',
            )}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              group.onSelect(m.id);
            }}
          >
            <MIcon size={12} />
            <span className="truncate">{m.title}</span>
            <button
              type="button"
              aria-label={`Close ${m.title}`}
              className="grid size-4 shrink-0 place-items-center rounded opacity-0 transition-opacity duration-fast hover:bg-surface-1 hover:text-fg-primary group-hover/chip:opacity-100"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                group.onCloseMember(m.id);
              }}
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
