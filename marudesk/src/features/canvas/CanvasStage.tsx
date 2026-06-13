import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Map as MapIcon, Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import type { TabKind } from '../../../shared/browser';
import { useTabsStore } from '../tabs/store';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { CanvasCard } from './CanvasCard';
import { CanvasEdges, type ConnectPreview } from './CanvasEdges';
import { CanvasMinimap } from './CanvasMinimap';
import { useCanvasStore } from './store';

type CanvasMenu =
  | { x: number; y: number; kind: 'canvas' }
  | { x: number; y: number; kind: 'card'; tabId: string }
  | { x: number; y: number; kind: 'edge'; edgeId: string };

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
  const edges = useCanvasStore((s) => s.edges);
  const selectedEdgeId = useCanvasStore((s) => s.selectedEdgeId);
  const viewport = useCanvasStore((s) => s.viewport);
  const focusedTabId = useCanvasStore((s) => s.focusedTabId);
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);

  // Scope cards to the active workspace so multiple workspaces don't pile onto
  // one canvas; fall back to all tabs when no workspace is active. Placements are
  // keyed by (unique) tab id, so the shared store needs no per-workspace split.
  const visibleTabs = activeWorkspaceId
    ? tabs.filter((t) => t.workspaceId === activeWorkspaceId)
    : tabs;
  // Only draw edges whose both endpoints are visible on this canvas.
  const visibleIds = new Set(visibleTabs.map((t) => t.id));
  const visibleEdges = edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));

  // Live connection-drag preview (canvas coords of the loose end), or null.
  const [connect, setConnect] = useState<ConnectPreview | null>(null);
  // Container size (px) for the minimap's viewport overlay, and minimap toggle.
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [minimapOpen, setMinimapOpen] = useState(true);
  // Right-click context menu (canvas / card / edge), or null.
  const [menu, setMenu] = useState<CanvasMenu | null>(null);

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
    const update = () => {
      measureWeb();
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
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
        // Zoom at the cursor (also catches trackpad pinch, which arrives as ctrl+wheel).
        const r = el.getBoundingClientRect();
        store.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      } else if (e.shiftKey) {
        // Shift + wheel = horizontal pan (Figma).
        store.panBy(-(e.deltaY || e.deltaX), 0);
      } else {
        // Plain wheel / trackpad = two-axis pan.
        store.panBy(-e.deltaX, -e.deltaY);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Only the empty canvas initiates a pan — never a card or an on-canvas
    // control (New card, zoom). Capturing the pointer here would otherwise
    // swallow their clicks.
    if ((e.target as HTMLElement).closest('[data-canvas-card], button, [data-edge-id]')) return;
    useCanvasStore.getState().setFocused(null);
    useCanvasStore.getState().selectEdge(null);
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

  // Use the tracked container `size` (not the ref) so these stay callable from
  // render-built menu items without reading a ref during render.
  const zoomFromCenter = (factor: number) => {
    useCanvasStore.getState().zoomAt(factor, size.w / 2, size.h / 2);
  };
  const fit = () => {
    useCanvasStore.getState().fitToContent(size.w, size.h);
  };

  // Screen px → canvas coords (inverse of the plane's translate+scale).
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const { panX, panY, scale } = useCanvasStore.getState().viewport;
    return { x: (clientX - r.left - panX) / scale, y: (clientY - r.top - panY) / scale };
  }, []);

  // Drag a connection from a card's port to another card. Window listeners (the
  // drag crosses the whole canvas); the drop target is hit-tested by [data-tab-id].
  const startConnect = useCallback(
    (fromTabId: string, clientX: number, clientY: number) => {
      const p = toCanvas(clientX, clientY);
      setConnect({ from: fromTabId, x: p.x, y: p.y });
      const onMove = (ev: PointerEvent) => {
        const q = toCanvas(ev.clientX, ev.clientY);
        setConnect((c) => (c ? { from: c.from, x: q.x, y: q.y } : c));
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setConnect(null);
        const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const target = el?.closest('[data-tab-id]')?.getAttribute('data-tab-id');
        if (target && target !== fromTabId) useCanvasStore.getState().addEdge(fromTabId, target);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [toCanvas],
  );

  // Recenter the viewport on a canvas point (minimap click). Uses `size` state
  // rather than the container ref so it's safe to build from render.
  const centerOn = (wx: number, wy: number) => {
    const { scale } = useCanvasStore.getState().viewport;
    useCanvasStore.getState().setPan(size.w / 2 - wx * scale, size.h / 2 - wy * scale);
  };

  const newCard = useCallback(
    (kind: TabKind = 'home') => {
      void useTabsStore.getState().newTab(kind, undefined, activeWorkspaceId ?? undefined);
    },
    [activeWorkspaceId],
  );

  // Right-click: a context menu for the edge / card-header / empty canvas under
  // the cursor. Right-clicking a card BODY is left to the surface (Monaco, xterm,
  // a web page) so its own menu still works — only the card header opens the card
  // menu.
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const edgeEl = t.closest('[data-edge-id]');
    if (edgeEl) {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, kind: 'edge', edgeId: edgeEl.getAttribute('data-edge-id') ?? '' });
      return;
    }
    const headerEl = t.closest('[data-card-header]');
    if (headerEl) {
      const id = headerEl.closest('[data-tab-id]')?.getAttribute('data-tab-id');
      if (id) {
        e.preventDefault();
        focusCard(id);
        setMenu({ x: e.clientX, y: e.clientY, kind: 'card', tabId: id });
        return;
      }
    }
    // Inside a card body → let the surface's own context menu handle it.
    if (t.closest('[data-canvas-card]')) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, kind: 'canvas' });
  };

  // Double-click empty canvas creates a card (Figma-style).
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-canvas-card], button, [data-edge-id]')) return;
    newCard('home');
  };

  const menuItems = (m: CanvasMenu): MenuItem[] => {
    const store = useCanvasStore.getState();
    if (m.kind === 'edge') {
      return [{ label: 'Remove connection', danger: true, onSelect: () => store.removeEdge(m.edgeId) }];
    }
    if (m.kind === 'card') {
      const tab = tabs.find((t) => t.id === m.tabId);
      const items: MenuItem[] = [
        { label: 'Bring to front', onSelect: () => store.bringToFront(m.tabId) },
        { label: 'Send to back', onSelect: () => store.sendToBack(m.tabId) },
      ];
      if (tab?.kind === 'web') {
        items.push(
          { type: 'separator' },
          {
            label: 'Reload',
            onSelect: () =>
              void (async () => {
                await useTabsStore.getState().activateTab(m.tabId);
                await window.marudesk.invoke('browser:reload');
              })(),
          },
          {
            label: 'Open DevTools',
            onSelect: () => void window.marudesk.invoke('devtools:popout-open', { tabId: m.tabId }),
          },
          {
            label: 'Copy link',
            disabled: !tab.url,
            onSelect: () => void window.marudesk.invoke('clipboard:write-text', tab.url),
          },
        );
      }
      items.push(
        { type: 'separator' },
        { label: 'Close card', danger: true, onSelect: () => void useTabsStore.getState().closeTab(m.tabId) },
      );
      return items;
    }
    return [
      { label: 'New browser tab', onSelect: () => newCard('web') },
      { label: 'New terminal', onSelect: () => newCard('terminal') },
      { label: 'New editor', onSelect: () => newCard('editor') },
      { label: 'New AI chat', onSelect: () => newCard('agent') },
      { type: 'separator' },
      { label: 'Fit to content', onSelect: () => fit() },
      { label: 'Reset zoom', onSelect: () => store.resetView() },
      { type: 'separator' },
      { label: minimapOpen ? 'Hide minimap' : 'Show minimap', onSelect: () => setMinimapOpen((v) => !v) },
    ];
  };

  // Canvas keyboard: ⌘/Ctrl+Shift+M toggles the minimap (cate parity); Delete
  // removes the selected connection (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editable =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setMinimapOpen((v) => !v);
        return;
      }
      if (e.key !== 'Delete' || editable) return;
      const sel = useCanvasStore.getState().selectedEdgeId;
      if (!sel) return;
      e.preventDefault();
      useCanvasStore.getState().removeEdge(sel);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      aria-label="Canvas"
    >
      <div
        className="absolute inset-0 origin-top-left"
        style={{
          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`,
        }}
      >
        {/* Node connections, drawn behind the cards. */}
        <CanvasEdges
          placements={placements}
          edges={visibleEdges}
          selectedEdgeId={selectedEdgeId}
          preview={connect}
          onSelectEdge={(id) => useCanvasStore.getState().selectEdge(id)}
          onRemoveEdge={(id) => useCanvasStore.getState().removeEdge(id)}
        />
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
              onStartConnect={(cx, cy) => startConnect(tab.id, cx, cy)}
            />
          );
        })}
      </div>

      {/* Minimap (cate parity — ⌘/Ctrl+Shift+M). */}
      {minimapOpen ? (
        <CanvasMinimap
          placements={placements}
          viewport={viewport}
          width={size.w}
          height={size.h}
          onJump={centerOn}
        />
      ) : null}

      {/* New-card button (top-left). The canvas replaces the tab strip, so this
          is the discoverable way to add a card; Ctrl+T does the same. */}
      <button
        type="button"
        onClick={() => newCard('home')}
        className="absolute left-3 top-3 z-50 inline-flex items-center gap-1.5 rounded-lg chrome-panel px-2.5 py-1.5 text-caption text-fg-secondary shadow-card hover:text-fg-primary"
      >
        <Plus size={14} />
        New card
      </button>

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
        <CtrlButton
          label={minimapOpen ? 'Hide minimap' : 'Show minimap'}
          onClick={() => setMinimapOpen((v) => !v)}
        >
          <MapIcon size={15} />
        </CtrlButton>
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />
      ) : null}
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
