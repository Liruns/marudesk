import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type DragEvent as ReactDragEvent,
} from 'react';
import { cn } from '../../lib/cn';
import { useTabsStore } from './store';
import { tabKinds } from './registry';
import { useGridStore } from './grid';
import { leaves, type LayoutNode, type PaneId } from './layout';
import { pickZone, zoneToSplit, type DropZone } from './dnd';
import { PaneHeader } from './PaneHeader';
import type { TabState } from '../../../shared/browser';

// Must match TabStrip's drag MIME so a tab dragged from the strip can be dropped
// onto a pane to split it.
const TAB_DND_MIME = 'application/x-marudesk-tab';

/**
 * The tiled tab grid (Phase F). Renders the layout tree as nested flex boxes
 * with thin tmux-style dividers; each leaf hosts a tab's surface. Web tabs get
 * a measured placeholder whose rect is shipped to main (which positions the
 * matching WebContentsView there); feature tabs render their React view inline.
 *
 * Only mounted when `useGridStore.layout` is non-null — `Stage` keeps the
 * single-view path untouched otherwise.
 */
export function GridStage() {
  const layout = useGridStore((s) => s.layout);
  const rootRef = useRef<HTMLDivElement>(null);
  // Live element refs for every web pane, keyed by leaf id, so we can measure
  // their rects after layout/resize and report them to main in one batch.
  const webPaneEls = useRef<Map<PaneId, HTMLDivElement>>(new Map());

  const registerWebPane = useCallback(
    (id: PaneId, el: HTMLDivElement | null) => {
      if (el) webPaneEls.current.set(id, el);
      else webPaneEls.current.delete(id);
    },
    [],
  );

  // MED-1: build the panes array directly in one pass — no intermediate
  // {tabId,rect:DOMRect}[] allocation, no second map over it, no live DOMRect
  // references held after the invoke.
  const measureAndSend = useCallback(() => {
    const panes: { tabId: string; rect: { x: number; y: number; width: number; height: number } }[] = [];
    if (layout) {
      for (const leaf of leaves(layout)) {
        if (!leaf.tabId) continue;
        const el = webPaneEls.current.get(leaf.id);
        if (!el) continue; // feature panes render inline — no placeholder el
        const r = el.getBoundingClientRect();
        panes.push({
          tabId: leaf.tabId,
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        });
      }
    }
    void window.marudesk.invoke('browser:set-pane-bounds', { panes });
  }, [layout]);

  // HIGH-2: `measureAndSend` already re-creates when `layout` changes (it's in
  // the dep array above), so this effect re-runs on every layout change — not
  // just on resize. That guarantees a closed pane's web view is hidden
  // immediately via the new (smaller) panes map, with no timing dependency on
  // the ResizeObserver firing.
  useLayoutEffect(() => {
    measureAndSend();
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => measureAndSend());
    ro.observe(root);
    window.addEventListener('resize', measureAndSend);
    window.addEventListener('scroll', measureAndSend, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measureAndSend);
      window.removeEventListener('scroll', measureAndSend, true);
    };
  }, [measureAndSend]);

  // Leaving the grid (layout → null) is handled by Stage unmounting this; tell
  // main to drop grid mode and restore the single active view.
  useEffect(() => {
    return () => {
      void window.marudesk.invoke('browser:clear-pane-bounds');
    };
  }, []);

  if (!layout) return null;

  return (
    <div
      ref={rootRef}
      className="flex-1 min-w-0 min-h-0 relative bg-surface-page"
      aria-label="Tab grid"
    >
      <GridNode node={layout} registerWebPane={registerWebPane} />
    </div>
  );
}

function GridNode({
  node,
  registerWebPane,
}: {
  node: LayoutNode;
  registerWebPane: (id: PaneId, el: HTMLDivElement | null) => void;
}) {
  if (node.type === 'leaf') {
    return <PaneLeaf leaf={node} registerWebPane={registerWebPane} />;
  }
  const isRow = node.dir === 'row';
  return (
    <div className={cn('flex min-w-0 min-h-0 w-full h-full', isRow ? 'flex-row' : 'flex-col')}>
      <div
        className="min-w-0 min-h-0 relative"
        style={isRow ? { width: `${node.ratio * 100}%` } : { height: `${node.ratio * 100}%` }}
      >
        <GridNode node={node.a} registerWebPane={registerWebPane} />
      </div>
      <Divider splitId={node.id} dir={node.dir} />
      <div className="flex-1 min-w-0 min-h-0 relative">
        <GridNode node={node.b} registerWebPane={registerWebPane} />
      </div>
    </div>
  );
}

/**
 * The seam between two panes. A 1px subtle line by default that thickens to the
 * violet accent on hover/drag, with a wider invisible hit area so it's easy to
 * grab (tmux-style: just a line, no bar). Dragging recomputes the parent split's
 * ratio from the pointer position within the *split container* it lives in.
 */
function Divider({ splitId, dir }: { splitId: PaneId; dir: 'row' | 'col' }) {
  const resize = useGridStore((s) => s.resize);
  const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isRow = dir === 'row';

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // The split container is this divider's parent (flex row/col with a, divider, b).
    const el = ref.current;
    const container = el?.parentElement;
    if (!el || !container) return;
    setActive(true);
    // MED-2: use pointer capture so pointermove is delivered even when the
    // cursor leaves the element, and lostpointercapture fires for *every* end
    // condition — pointerup, pointercancel, window blur — eliminating the
    // window-listener leak the previous approach had.
    el.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio = isRow
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      resize(splitId, ratio);
    };
    const onDone = () => {
      setActive(false);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('lostpointercapture', onDone);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('lostpointercapture', onDone);
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={isRow ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      className={cn(
        'relative shrink-0 z-10 group',
        isRow ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        active ? 'bg-accent' : 'bg-subtle hover:bg-accent',
        'transition-colors duration-fast',
      )}
    >
      {/* Invisible wider hit area centered on the 1px seam. */}
      <span
        aria-hidden
        className={cn(
          'absolute',
          isRow ? 'inset-y-0 -left-1.5 -right-1.5' : 'inset-x-0 -top-1.5 -bottom-1.5',
        )}
      />
    </div>
  );
}

function PaneLeaf({
  leaf,
  registerWebPane,
}: {
  leaf: Extract<LayoutNode, { type: 'leaf' }>;
  registerWebPane: (id: PaneId, el: HTMLDivElement | null) => void;
}) {
  const tabs = useTabsStore((s) => s.tabs);
  const focusedPaneId = useGridStore((s) => s.focusedPaneId);
  const focus = useGridStore((s) => s.focus);
  const splitWith = useGridStore((s) => s.splitWith);
  const closePane = useGridStore((s) => s.closePane);
  const activateTab = useTabsStore((s) => s.activateTab);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);

  const tab = tabs.find((t) => t.id === leaf.tabId);
  const focused = focusedPaneId === leaf.id;

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TAB_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    setDropZone(pickZone(rect, e.clientX, e.clientY));
  };
  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    // Ignore leaves into children; only clear when truly leaving the pane.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropZone(null);
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TAB_DND_MIME)) return;
    e.preventDefault();
    const draggedId = e.dataTransfer.getData(TAB_DND_MIME);
    const zone = dropZone ?? pickZone(
      e.currentTarget.getBoundingClientRect(),
      e.clientX,
      e.clientY,
    );
    setDropZone(null);
    if (!draggedId) return;
    const { dir, side } = zoneToSplit(zone);
    splitWith(leaf.id, draggedId, dir, side);
  };

  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col overflow-hidden bg-surface-1',
        'ring-inset transition-shadow duration-fast',
        focused ? 'ring-1 ring-accent/40' : 'ring-0',
      )}
      onMouseDown={() => {
        focus(leaf.id);
        if (leaf.tabId) void activateTab(leaf.tabId);
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label="Grid pane"
    >
      {tab ? (
        <PaneHeader
          tab={tab}
          focused={focused}
          onClose={() => closePane(leaf.id)}
        />
      ) : null}
      <PaneContent leaf={leaf} tab={tab} registerWebPane={registerWebPane} />
      {dropZone ? <DropHint zone={dropZone} /> : null}
    </div>
  );
}

function PaneContent({
  leaf,
  tab,
  registerWebPane,
}: {
  leaf: Extract<LayoutNode, { type: 'leaf' }>;
  tab: TabState | undefined;
  registerWebPane: (id: PaneId, el: HTMLDivElement | null) => void;
}) {
  if (!tab) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-center px-6 pointer-events-none">
        <p className="text-caption text-fg-tertiary">
          Empty pane — drag a tab here
        </p>
      </div>
    );
  }
  // Web tabs render nothing in React: the native WebContentsView paints over a
  // measured placeholder whose rect we report to main.
  if (tab.kind === 'web') {
    return (
      <div
        ref={(el) => registerWebPane(leaf.id, el)}
        className="flex-1 min-h-0 bg-surface-1"
        aria-label="Web pane"
      />
    );
  }
  // Feature tabs render their React surface (from the shared tab-kind registry),
  // pinned to this pane's tab id so each pane resolves its own buffer/session.
  return tabKinds[tab.kind].render(tab.id);
}

function DropHint({ zone }: { zone: DropZone }) {
  // A translucent accent slab over the half the new pane will occupy.
  const pos =
    zone === 'left'
      ? 'inset-y-0 left-0 w-1/2'
      : zone === 'right'
        ? 'inset-y-0 right-0 w-1/2'
        : zone === 'top'
          ? 'inset-x-0 top-0 h-1/2'
          : 'inset-x-0 bottom-0 h-1/2';
  return (
    <div
      aria-hidden
      className={cn(
        'absolute z-30 pointer-events-none rounded-sm',
        'bg-accent/20 border border-accent',
        pos,
      )}
    />
  );
}


