import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  RotateCw,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/messages';
import { tabKinds } from '../tabs/registry';
import { cardMinSize, EDGE_SIDES, useCanvasStore, type CardRect, type EdgeSide } from './store';
import type { TabState } from '../../../shared/browser';

/** Per-face connection-port accessible name (the side is meaningful for both a11y
 *  and the e2e port selectors). */
const CONNECT_LABEL: Record<EdgeSide, TranslationKey> = {
  top: 'canvas.connect.top',
  right: 'canvas.connect.right',
  bottom: 'canvas.connect.bottom',
  left: 'canvas.connect.left',
};

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
type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Where each face's connection port sits, centered just outside the frame. */
const PORT_POS: Record<EdgeSide, string> = {
  top: '-top-2 left-1/2 -translate-x-1/2',
  right: '-right-2 top-1/2 -translate-y-1/2',
  bottom: '-bottom-2 left-1/2 -translate-x-1/2',
  left: '-left-2 top-1/2 -translate-y-1/2',
};

/**
 * The 8 resize hit-strips, mounted just OUTSIDE the frame (negative offsets) so
 * they clear a web card's native view + inner scrollbars (cate's NodeResizeOverlay
 * approach). Edges are thin strips between the corners; corners are small squares.
 * Each carries its `data-resize-dir`; the cursor signals the axis.
 */
const RESIZE_HANDLES: { dir: ResizeDir; cls: string }[] = [
  { dir: 'n', cls: '-top-1 left-4 right-4 h-2 cursor-ns-resize' },
  { dir: 's', cls: '-bottom-1 left-4 right-4 h-2 cursor-ns-resize' },
  { dir: 'w', cls: '-left-1 top-4 bottom-4 w-2 cursor-ew-resize' },
  { dir: 'e', cls: '-right-1 top-4 bottom-4 w-2 cursor-ew-resize' },
  { dir: 'nw', cls: '-top-1.5 -left-1.5 h-4 w-4 cursor-nwse-resize' },
  { dir: 'ne', cls: '-top-1.5 -right-1.5 h-4 w-4 cursor-nesw-resize' },
  { dir: 'sw', cls: '-bottom-1.5 -left-1.5 h-4 w-4 cursor-nesw-resize' },
  { dir: 'se', cls: '-bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize' },
];

export function CanvasCard({
  tab,
  placeKey,
  rect,
  scale,
  focused,
  selected,
  onFocus,
  onClose,
  onMove,
  onMoveEnd,
  onNudge,
  onResize,
  registerWebEl,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onOpenDevtools,
  onStartConnect,
  group,
  mergeHighlight,
  onHeaderDragMove,
  onHeaderDrop,
  locked,
  maximized,
  onToggleLock,
  onToggleMaximize,
}: {
  tab: TabState;
  /** This card's canvas placement key (tab id, or group id when merged) — lets a
   *  section drag find and move the card's DOM element directly. */
  placeKey: string;
  rect: CardRect;
  scale: number;
  focused: boolean;
  /** Part of the multi-selection (marquee / shift-click) — shows a select ring. */
  selected?: boolean;
  /** `additive` (shift) toggles this card in the multi-selection. */
  onFocus: (additive?: boolean) => void;
  onClose: () => void;
  /** Live header-drag position (painted to the DOM directly by the stage). `t` is
   *  the pointer event's timestamp, used by the stage for release-fling velocity. */
  onMove: (x: number, y: number, t?: number) => void;
  /** Header drag released — commit the live move (`t` = pointerup timestamp). */
  onMoveEnd?: (t?: number) => void;
  /** Keyboard move (no snap), so arrow-nudge stays precise. Falls back to onMove. */
  onNudge?: (x: number, y: number) => void;
  /** Live resize size (painted to the DOM directly); committed on pointer-up. */
  onResize: (w: number, h: number) => void;
  registerWebEl?: (el: HTMLDivElement | null) => void;
  onNavigate?: (input: string) => void;
  /** Web-card browser controls (back / forward / reload this card's own view). */
  onGoBack?: () => void;
  onGoForward?: () => void;
  onReload?: () => void;
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
  /** Locked: no move/resize/connect; the lock toggle stays available. */
  locked?: boolean;
  /** Whether the card is currently maximized (shows the restore icon). */
  maximized?: boolean;
  onToggleLock?: () => void;
  onToggleMaximize?: () => void;
}) {
  const { t } = useI18n();
  const isWeb = tab.kind === 'web';
  const rootRef = useRef<HTMLDivElement>(null);
  // Default to '' (not tab.url, which is undefined for a blank web card) so the
  // address <input> is always controlled — a undefined→string switch otherwise
  // trips React's controlled/uncontrolled warning.
  const [addr, setAddr] = useState(tab.url ?? '');
  const addrFocused = useRef(false);
  useEffect(() => {
    if (!addrFocused.current) setAddr(tab.url ?? '');
  }, [tab.url]);
  const Icon = tabKinds[tab.kind]?.icon ?? Globe;
  const title = tab.title?.trim() || tab.url || tabKinds[tab.kind]?.title || t('canvas.card.fallbackTitle');
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  // Resize is painted straight to the DOM during the gesture (no per-frame store
  // write / re-render) and committed once on release — `x/y/w/h` track the live rect.
  const resizeState = useRef<{ pointerId: number; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number; dir: ResizeDir; x: number; y: number; w: number; h: number } | null>(null);

  // Re-assert the live resize rect after any incidental re-render mid-gesture so
  // the card never snaps back to its stale stored rect for a frame.
  useLayoutEffect(() => {
    const s = resizeState.current;
    const el = rootRef.current;
    if (!s || !el) return;
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    el.style.width = `${s.w}px`;
    el.style.height = `${s.h}px`;
  });

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus(e.shiftKey);
    rootRef.current?.focus(); // so arrow-nudge / Delete work after a click
    if (locked) return; // locked cards can be selected but not dragged
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origX: rect.x, origY: rect.y, moved: false };
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (Math.abs(e.clientX - s.startX) > 3 || Math.abs(e.clientY - s.startY) > 3) s.moved = true;
    onMove(
      s.origX + (e.clientX - s.startX) / scale,
      s.origY + (e.clientY - s.startY) / scale,
      e.timeStamp,
    );
    if (s.moved) onHeaderDragMove?.(e.clientX, e.clientY);
  };
  const onHeaderPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragState.current;
    if (s?.pointerId !== e.pointerId) return;
    // Commit the live (DOM-painted) move to the store first, THEN let a drop
    // merge — mergeInto removes the standalone placement, so it wins if it fires.
    onMoveEnd?.(e.timeStamp);
    if (s.moved) onHeaderDrop?.(e.clientX, e.clientY);
    dragState.current = null;
  };

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || locked) return;
    e.stopPropagation();
    onFocus(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    const dir = (e.currentTarget.dataset.resizeDir as ResizeDir | undefined) ?? 'se';
    resizeState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.x,
      origY: rect.y,
      origW: rect.w,
      origH: rect.h,
      dir,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    };
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = resizeState.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = (e.clientX - s.startX) / scale;
    const dy = (e.clientY - s.startY) / scale;
    const min = cardMinSize(tab.kind);
    let x = s.origX;
    let y = s.origY;
    let w = s.origW;
    let h = s.origH;
    // East/south edges grow size; west/north edges move the origin and shrink,
    // keeping the opposite edge fixed.
    if (s.dir.includes('e')) w = s.origW + dx;
    if (s.dir.includes('s')) h = s.origH + dy;
    if (s.dir.includes('w')) {
      w = s.origW - dx;
      x = s.origX + dx;
    }
    if (s.dir.includes('n')) {
      h = s.origH - dy;
      y = s.origY + dy;
    }
    // Clamp to the kind's minimum, pinning the opposite (right/bottom) edge when
    // resizing from the west/north so the card doesn't slide past its own edge.
    if (w < min.w) {
      if (s.dir.includes('w')) x -= min.w - w;
      w = min.w;
    }
    if (h < min.h) {
      if (s.dir.includes('n')) y -= min.h - h;
      h = min.h;
    }
    // Paint the new rect straight to the DOM; commit to the store on release.
    s.x = x;
    s.y = y;
    s.w = w;
    s.h = h;
    const el = rootRef.current;
    if (el) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
  };
  const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = resizeState.current;
    if (!s || s.pointerId !== e.pointerId) return;
    resizeState.current = null;
    onResize(s.w, s.h);
    // Free placement (no snap) for the moved edge during resize.
    if (s.x !== s.origX || s.y !== s.origY) (onNudge ?? onMove)(s.x, s.y);
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
      // If an edge is selected, let the canvas-level handler remove the EDGE —
      // one Delete must do one thing, not also close this focused card.
      if (useCanvasStore.getState().selectedEdgeId) return;
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
      data-place-key={placeKey}
      role="group"
      aria-label={`${title} ${t('canvas.card.suffix')}`}
      tabIndex={0}
      className={cn(
        'group @container absolute flex flex-col rounded-lg chrome-panel transition-shadow duration-fast',
        mergeHighlight
          ? 'ring-2 ring-accent shadow-lifted'
          : selected
            ? 'ring-2 ring-accent/80 shadow-lifted'
            : focused
              ? 'ring-1 ring-accent/60 shadow-lifted'
              : 'shadow-card hover:shadow-lifted',
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: rect.z }}
      onPointerDown={(e) => onFocus(e.shiftKey)}
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
            {isWeb && (onGoBack || onGoForward || onReload) ? (
              // Real browser chrome on the card: back / forward / reload drive THIS
              // card's own view. Shown from @[16rem] so a tiny card keeps just the
              // address bar. Each stops propagation so it doesn't start a header drag.
              <div className="hidden @[16rem]:flex shrink-0 items-center gap-0.5">
                <CardNavButton label={t('canvas.card.back')} onClick={onGoBack}>
                  <ArrowLeft size={13} />
                </CardNavButton>
                <CardNavButton label={t('canvas.card.forward')} onClick={onGoForward}>
                  <ArrowRight size={13} />
                </CardNavButton>
                <CardNavButton label={t('canvas.card.reload')} onClick={onReload}>
                  <RotateCw size={12} />
                </CardNavButton>
              </div>
            ) : (
              <span className="shrink-0 text-fg-tertiary">
                <Icon size={14} />
              </span>
            )}
            {isWeb ? (
              <input
                value={addr}
                spellCheck={false}
                placeholder={t('canvas.card.addressPlaceholder')}
                aria-label={t('canvas.card.address')}
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
            aria-label={t('canvas.card.devtools')}
            title={t('canvas.card.devtools')}
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
        {onToggleMaximize ? (
          <button
            type="button"
            aria-label={maximized ? t('canvas.card.restoreAria') : t('canvas.card.maximizeAria')}
            title={maximized ? t('canvas.card.restore') : t('canvas.card.maximize')}
            className="hidden @[18rem]:grid place-items-center h-6 w-6 rounded text-fg-tertiary transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMaximize();
            }}
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        ) : null}
        {onToggleLock ? (
          <button
            type="button"
            aria-label={locked ? t('canvas.card.unlockAria') : t('canvas.card.lockAria')}
            title={locked ? t('canvas.card.unlock') : t('canvas.card.lock')}
            className={cn(
              'grid place-items-center h-6 w-6 rounded transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary',
              locked ? 'text-accent' : 'text-fg-tertiary',
            )}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleLock();
            }}
          >
            {locked ? <Lock size={13} /> : <LockOpen size={13} />}
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t('canvas.card.close')}
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
          <div ref={registerWebEl} className="relative h-full w-full bg-surface-1" aria-label={t('canvas.card.web')}>
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

      {/* Semantic zoom (LOD): zoomed far out, the surface is an unreadable smear,
          so overlay a legible icon+title chip. Sized in inverse-scale units so it
          stays ~constant on screen, and pointer-events-none so move/select still
          pass through to the frame. The heavy surface stays mounted underneath —
          its state (terminal scrollback, editor, page) survives the zoom. (A web
          card's native view composites above this, so it keeps showing the page.) */}
      {scale < 0.5 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center rounded-lg bg-surface-1 text-fg-secondary"
          style={{ gap: `${6 / scale}px` }}
        >
          <Icon size={Math.round(22 / scale)} />
          <span
            className="max-w-[88%] truncate font-medium text-fg-primary"
            style={{ fontSize: `${13 / scale}px`, lineHeight: 1.2 }}
          >
            {title}
          </span>
        </div>
      ) : null}

      {/* Connection ports — one per face (top/right/bottom/left), just outside
          the body so they clear a web card's native view. z-20 so each wins its
          overlap with the resize hit-strips (z-10). Drag a port onto another card
          to wire them; the port's side pins that end of the edge. */}
      {onStartConnect && !locked
        ? EDGE_SIDES.map((side) => (
            <button
              key={side}
              type="button"
              aria-label={t(CONNECT_LABEL[side])}
              title={t('canvas.card.connect')}
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

      {/* Resize handles — 8 directions (edges + corners). Transparent hit-strips
          mounted just outside the frame (clear of a web card's native view +
          inner scrollbars); the SE corner shows a grip on hover/focus and keeps
          the "Resize card" accessible name. Hidden while locked. */}
      {!locked &&
        RESIZE_HANDLES.map(({ dir, cls }) => (
        <div
          key={dir}
          {...(dir === 'se'
            ? { role: 'separator' as const, 'aria-label': t('canvas.card.resize') }
            : { 'aria-hidden': true })}
          data-resize-dir={dir}
          className={cn('absolute z-10', cls)}
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        >
          {dir === 'se' ? (
            <span
              aria-hidden
              className={cn(
                'absolute bottom-1 right-1 h-2 w-2 border-b-2 border-r-2 border-strong transition-opacity duration-fast',
                reveal,
              )}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A compact web-card chrome button (back / forward / reload). Stops pointer
 *  propagation so a click never starts a header drag; disabled with no handler. */
function CardNavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!onClick}
      className="grid h-6 w-6 place-items-center rounded text-fg-tertiary transition-colors duration-fast hover:bg-surface-3 hover:text-fg-primary disabled:opacity-40 disabled:hover:bg-transparent"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {children}
    </button>
  );
}

/** The merged-card header: a horizontal strip of member tabs. Click to switch,
 *  × to close a member; the chips stop propagation so they don't start a drag. */
function GroupTabStrip({ group }: { group: CardGroupProps }) {
  const { t } = useI18n();
  return (
    <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto scrollbar-none">
      {group.members.map((m) => {
        const MIcon = m.icon;
        const active = m.id === group.activeId;
        return (
          <div
            key={m.id}
            role="tab"
            data-member-tab-id={m.id}
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
              aria-label={t('canvas.card.closeMember')}
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
