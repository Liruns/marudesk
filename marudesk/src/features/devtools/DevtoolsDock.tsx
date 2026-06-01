import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { ExternalLink, PanelBottom, PanelRight, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useDevtoolsStore } from './store';
import { MainTabBar, DevtoolsContent } from './DevtoolsContent';

/**
 * The DevTools dock: a React flex sibling of the browser stage (mounted by
 * BrowserCanvas). Its width/height shrinks the embedded web view for free via
 * BrowserCanvas's ResizeObserver; the splitter additionally pushes the exact web
 * rect during a drag (`devtools:set-dock-bounds`) so the native view tracks the
 * handle without a frame of lag (design §6 / HIGH-1).
 *
 * It reads its own parent element's rect to compute that web rect, so it needs
 * no knowledge of the toolbar above the stage — the flex wrapper is exactly
 * `[stage][dock]`.
 *
 * The bottom drawer (Chrome-style) lives INSIDE the dock body (DevtoolsContent),
 * so opening it doesn't change the dock's outer rect — the web view needs no
 * extra shrink. Esc toggles the drawer (when no Console autocomplete popup is
 * intercepting it; that popup stops propagation so its own Esc closes it first).
 */

const MIN_PAGE = 160;

export function DevtoolsDock() {
  const side = useDevtoolsStore((s) => s.side);
  const size = useDevtoolsStore((s) => s.size);
  const dropped = useDevtoolsStore((s) => s.dropped);
  const ref = useRef<HTMLDivElement>(null);
  const isRight = side === 'right';

  // Esc toggles the bottom drawer (Chrome-style). A window-level (bubble)
  // listener so it works regardless of which dock element has focus, but guarded
  // so it never hijacks Esc from inputs OUTSIDE the dock (address bar, agent
  // chat): it only acts when focus is within the dock or nowhere in particular.
  // The Console autocomplete popup stops propagation on its own Esc (so the
  // popup closes first), and a context menu marks the event defaultPrevented —
  // both keep this from double-acting.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const dock = ref.current;
      const active = document.activeElement;
      const focusOutside =
        active && active !== document.body && dock && !dock.contains(active);
      if (focusOutside) return;
      useDevtoolsStore.getState().toggleDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onHandleDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const wrapper = ref.current?.parentElement;
    if (!wrapper) return;
    const { setSize } = useDevtoolsStore.getState();
    let raf = 0;
    // Re-measure the wrapper each frame rather than caching it: the window can
    // resize / zoom mid-drag, and a stale rect would drift the pushed web bounds
    // from the real stage (the seam the design's HIGH-1 warns about).
    const flush = () => {
      raf = 0;
      const r = wrapper.getBoundingClientRect();
      const s = useDevtoolsStore.getState().size;
      const webRect = isRight
        ? { x: r.left, y: r.top, width: Math.max(0, r.width - s), height: r.height }
        : { x: r.left, y: r.top, width: r.width, height: Math.max(0, r.height - s) };
      void window.marudesk.invoke('devtools:set-dock-bounds', webRect);
    };
    const move = (ev: PointerEvent) => {
      const r = wrapper.getBoundingClientRect();
      const span = isRight ? r.width : r.height;
      const next = isRight ? r.right - ev.clientX : r.bottom - ev.clientY;
      setSize(Math.min(next, span - MIN_PAGE));
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (raf) cancelAnimationFrame(raf);
      // Hand authority back to the ResizeObserver steady-state path.
      void window.marudesk.invoke('devtools:set-dock-bounds', null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      style={isRight ? { width: size } : { height: size }}
      className={cn(
        'shrink-0 relative flex flex-col min-w-0 min-h-0 bg-surface-1 overflow-hidden outline-none',
        isRight ? 'border-l border-subtle' : 'border-t border-subtle',
      )}
      aria-label="DevTools"
    >
      {/* Splitter on the edge facing the page */}
      <div
        onPointerDown={onHandleDown}
        className={cn(
          'absolute z-20 hover:bg-accent/50 active:bg-accent transition-colors',
          isRight
            ? 'left-0 top-0 h-full w-1 cursor-col-resize'
            : 'top-0 left-0 w-full h-1 cursor-row-resize',
        )}
        aria-hidden
      />

      {/* Header: main panel tabs + dock controls */}
      <div className="shrink-0 h-9 flex items-center gap-0.5 pl-2 pr-1 border-b border-subtle bg-surface-2/40">
        <MainTabBar />
        <div className="flex-1" />
        {dropped > 0 ? (
          <span
            title={`${dropped} events dropped (event flood)`}
            className="text-caption text-warning px-1.5 tabular-nums"
          >
            {dropped} dropped
          </span>
        ) : null}
        <DockIconButton
          label="Pop out into a window"
          onClick={() => useDevtoolsStore.getState().popOut()}
        >
          <ExternalLink size={15} />
        </DockIconButton>
        <DockIconButton
          label={isRight ? 'Dock to bottom' : 'Dock to right'}
          onClick={() => useDevtoolsStore.getState().setSide(isRight ? 'bottom' : 'right')}
        >
          {isRight ? <PanelBottom size={15} /> : <PanelRight size={15} />}
        </DockIconButton>
        <DockIconButton label="Close DevTools" onClick={() => useDevtoolsStore.getState().close()}>
          <X size={15} />
        </DockIconButton>
      </div>

      {/* Body: main panel + bottom drawer */}
      <DevtoolsContent />
    </div>
  );
}

function DockIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="size-7 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast"
    >
      {children}
    </button>
  );
}
