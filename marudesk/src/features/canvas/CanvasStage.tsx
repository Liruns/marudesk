import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useTabsStore } from '../tabs/store';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { CanvasCard } from './CanvasCard';
import { useCanvasStore } from './store';

/**
 * The infinite-canvas surface (Maru — see docs/maru-identity-and-canvas-design.md).
 * A pannable / zoomable plane that hosts every open tab as a freeform card. Pan by
 * dragging empty space or scrolling; zoom with ⌘/Ctrl + wheel or the controls.
 *
 * Feature cards render via the shared `tabKinds` registry; web cards report their
 * (post-transform) screen rect through the same `set-pane-bounds` pipeline the
 * split grid uses (electron/browser/layout.ts), so the live WebContentsView tracks
 * the card. Repositioning is coalesced to one IPC per animation frame.
 */
export function CanvasStage() {
  const tabs = useTabsStore((s) => s.tabs);
  const activateTab = useTabsStore((s) => s.activateTab);
  const placements = useCanvasStore((s) => s.placements);
  const viewport = useCanvasStore((s) => s.viewport);
  const focusedTabId = useCanvasStore((s) => s.focusedTabId);
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);

  // Scope cards to the active workspace so multiple workspaces don't pile onto
  // one canvas; fall back to all tabs when no workspace is active. Placements are
  // keyed by (unique) tab id, so the shared store needs no per-workspace split.
  const visibleTabs = activeWorkspaceId
    ? tabs.filter((t) => t.workspaceId === activeWorkspaceId)
    : tabs;

  const containerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);
  // Live element refs for web cards, keyed by tab id, so we can measure their
  // screen rects and position the matching native WebContentsViews.
  const webEls = useRef<Map<string, HTMLDivElement>>(new Map());
  // Coalesce web-view repositioning to one IPC per animation frame and skip it
  // when nothing moved — pan/zoom otherwise fires set-pane-bounds on every
  // pointer event (100+/sec).
  const rafRef = useRef<number | null>(null);
  const lastSentRef = useRef<string>('');

  const tabIdsKey = tabs.map((t) => t.id).join('\n');

  const registerWebEl = useCallback((tabId: string, el: HTMLDivElement | null) => {
    if (el) webEls.current.set(tabId, el);
    else webEls.current.delete(tabId);
  }, []);

  // Position live web views to follow their cards through the SAME pane-bounds
  // pipeline the split grid uses (electron/browser/layout.ts). An empty list
  // still means "grid mode" → every web view hides, so feature-only canvases
  // show the React surfaces through. `getBoundingClientRect()` is post-transform,
  // so the reported rect already reflects pan + zoom.
  const measureWeb = useCallback(() => {
    if (rafRef.current !== null) return; // already scheduled this frame
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const panes: { tabId: string; rect: { x: number; y: number; width: number; height: number } }[] = [];
      for (const [tabId, el] of webEls.current) {
        const r = el.getBoundingClientRect();
        panes.push({
          tabId,
          rect: {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
        });
      }
      const key = JSON.stringify(panes);
      if (key === lastSentRef.current) return; // nothing moved → skip the IPC
      lastSentRef.current = key;
      void window.marudesk.invoke('browser:set-pane-bounds', { panes });
    });
  }, []);

  // Keep placements in step with the open tabs (initial mount + later changes).
  useEffect(() => {
    useCanvasStore.getState().syncPlacements(tabIdsKey ? tabIdsKey.split('\n') : []);
  }, [tabIdsKey]);

  // Re-measure web views on any viewport (pan/zoom) or placement (move) change,
  // and on the tab set changing, so the native views track the cards.
  useLayoutEffect(() => {
    measureWeb();
  }, [measureWeb, viewport, placements, tabIdsKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measureWeb());
    ro.observe(el);
    window.addEventListener('resize', measureWeb);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measureWeb);
    };
  }, [measureWeb]);

  // Leave grid mode on unmount so the classic shell's single active web view is
  // restored when switching back from the canvas (and cancel any pending frame).
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      void window.marudesk.invoke('browser:clear-pane-bounds');
    };
  }, []);

  // Native, non-passive wheel so we can preventDefault: ⌘/Ctrl = zoom-at-cursor,
  // otherwise two-axis pan. React's synthetic onWheel is passive and can't block
  // the browser's own scroll/zoom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const store = useCanvasStore.getState();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        store.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      } else {
        store.panBy(-e.deltaX, -e.deltaY);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-canvas-card]')) return; // card handles its own
    useCanvasStore.getState().setFocused(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    setPanning(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    useCanvasStore.getState().panBy(dx, dy);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId === e.pointerId) {
      panRef.current = null;
      setPanning(false);
    }
  };

  const focusCard = (tabId: string) => {
    const store = useCanvasStore.getState();
    store.setFocused(tabId);
    store.bringToFront(tabId);
    void activateTab(tabId);
  };

  const zoomFromCenter = (factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    useCanvasStore.getState().zoomAt(factor, r.width / 2, r.height / 2);
  };
  const fit = () => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    useCanvasStore.getState().fitToContent(r.width, r.height);
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative h-full w-full overflow-hidden bg-surface-page',
        panning ? 'cursor-grabbing' : 'cursor-grab',
      )}
      style={{
        backgroundImage: 'radial-gradient(var(--border-subtle) 1px, transparent 1.6px)',
        backgroundSize: `${24 * viewport.scale}px ${24 * viewport.scale}px`,
        backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label="Canvas"
    >
      <div
        className="absolute inset-0 origin-top-left"
        style={{
          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`,
        }}
      >
        {visibleTabs.map((tab) => {
          const rect = placements[tab.id];
          if (!rect) return null;
          return (
            <CanvasCard
              key={tab.id}
              tab={tab}
              rect={rect}
              scale={viewport.scale}
              focused={focusedTabId === tab.id}
              onFocus={() => focusCard(tab.id)}
              onClose={() => void useTabsStore.getState().closeTab(tab.id)}
              onMove={(x, y) => useCanvasStore.getState().setPos(tab.id, x, y)}
              onResize={(w, h) => useCanvasStore.getState().setSize(tab.id, w, h)}
              registerWebEl={
                tab.kind === 'web' ? (el) => registerWebEl(tab.id, el) : undefined
              }
              onNavigate={
                tab.kind === 'web'
                  ? (input) => {
                      // Navigate targets the active tab, so activate this card's
                      // tab first, then hand the input to the browser (it
                      // normalizes URL vs. search term in the main process).
                      void (async () => {
                        await useTabsStore.getState().activateTab(tab.id);
                        await window.marudesk.invoke('browser:navigate', input);
                      })();
                    }
                  : undefined
              }
              onOpenDevtools={
                tab.kind === 'web'
                  ? () => void window.marudesk.invoke('devtools:popout-open', { tabId: tab.id })
                  : undefined
              }
            />
          );
        })}
      </div>

      {/* Viewport controls (bottom-right). */}
      <div className="absolute bottom-4 right-4 z-50 flex items-center gap-0.5 rounded-lg chrome-panel px-1.5 py-1 shadow-card">
        <CtrlButton label="Zoom out" onClick={() => zoomFromCenter(1 / 1.2)}>
          <Minus size={15} />
        </CtrlButton>
        <button
          type="button"
          className="min-w-[3.25rem] px-1 text-center text-caption tabular-nums text-fg-secondary hover:text-fg-primary"
          onClick={() => useCanvasStore.getState().resetView()}
          title="Reset zoom to 100%"
        >
          {Math.round(viewport.scale * 100)}%
        </button>
        <CtrlButton label="Zoom in" onClick={() => zoomFromCenter(1.2)}>
          <Plus size={15} />
        </CtrlButton>
        <div className="mx-0.5 h-5 w-px bg-subtle" />
        <CtrlButton label="Fit to content" onClick={fit}>
          <Maximize2 size={15} />
        </CtrlButton>
        <CtrlButton label="Reset view" onClick={() => useCanvasStore.getState().resetView()}>
          <RotateCcw size={15} />
        </CtrlButton>
      </div>
    </div>
  );
}

function CtrlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
    >
      {children}
    </button>
  );
}
