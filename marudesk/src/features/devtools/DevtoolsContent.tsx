import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { useDevtoolsStore, type DevtoolsPanel, type ToolLocation } from './store';
import { PANELS } from './panel-list';
import { PanelById } from './DevtoolsBody';

/**
 * The shared DevTools surface: the main panel area plus the Chrome-style bottom
 * drawer (a draggable horizontal split). Both the in-page dock and the pop-out
 * window mount this; each supplies its own surrounding chrome (dock controls /
 * "dock back"). The main tab bar lives here too (MainTabBar) so the tab→panel
 * mapping and the move-between-locations context menu have one home.
 *
 * Layout when the drawer is open:
 *   [ main panel (flex-1) ]
 *   [ horizontal splitter ]
 *   [ drawer: its own tab bar + close, then the drawer panel ]
 * The drawer takes its height from WITHIN the dock, so the embedded web view —
 * already sized to the dock's outer rect — needs no further shrink.
 */

const DRAWER_MIN = 80;

const PANEL_LABEL = new Map<DevtoolsPanel, string>(PANELS.map((p) => [p.id, p.label]));

/** Tools assigned to a location, in display order. */
function useToolsIn(location: ToolLocation): DevtoolsPanel[] {
  const tools = useDevtoolsStore((s) => s.tools);
  return useMemo(
    () =>
      tools
        .filter((t) => t.location === location)
        .sort((a, b) => a.order - b.order)
        .map((t) => t.id),
    [tools, location],
  );
}

type TabMenuState = { panel: DevtoolsPanel; x: number; y: number } | null;

/** A panel tab with a right-click menu to move it between the bar and drawer. */
function ArrangeableTab({
  panel,
  active,
  onClick,
  onContextMenu,
}: {
  panel: DevtoolsPanel;
  active: boolean;
  onClick: () => void;
  onContextMenu: (e: ReactPointerEvent | React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'h-7 px-2.5 rounded text-body-sm transition-colors duration-fast',
        active
          ? 'bg-surface-page text-fg-primary'
          : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
      )}
    >
      {PANEL_LABEL.get(panel) ?? panel}
    </button>
  );
}

/** The move menu shared by both locations. */
function useTabMenu(): {
  menu: TabMenuState;
  open: (panel: DevtoolsPanel, e: ReactPointerEvent | React.MouseEvent) => void;
  node: React.ReactNode;
} {
  const [menu, setMenu] = useState<TabMenuState>(null);
  const open = (panel: DevtoolsPanel, e: ReactPointerEvent | React.MouseEvent) => {
    e.preventDefault();
    setMenu({ panel, x: e.clientX, y: e.clientY });
  };
  const node = menu ? (
    <TabContextMenu state={menu} onClose={() => setMenu(null)} />
  ) : null;
  return { menu, open, node };
}

function TabContextMenu({
  state,
  onClose,
}: {
  state: NonNullable<TabMenuState>;
  onClose: () => void;
}) {
  const tools = useDevtoolsStore((s) => s.tools);
  const current = tools.find((t) => t.id === state.panel)?.location ?? 'main';
  const move = (location: ToolLocation) =>
    useDevtoolsStore.getState().moveTool(state.panel, location);
  const items: MenuItem[] =
    current === 'main'
      ? [{ label: 'Move to bottom', onSelect: () => move('drawer') }]
      : [{ label: 'Move to top', onSelect: () => move('main') }];
  return <ContextMenu x={state.x} y={state.y} items={items} onClose={onClose} />;
}

/**
 * The main (top) tab bar: the tools assigned to the main location. Mounted in
 * the host's header row (so dock/pop-out controls can sit beside it). Returns a
 * fragment of buttons + the (portaled) context menu.
 */
export function MainTabBar() {
  const mainTools = useToolsIn('main');
  const panel = useDevtoolsStore((s) => s.panel);
  const { open, node } = useTabMenu();
  return (
    <>
      {mainTools.map((id) => (
        <ArrangeableTab
          key={id}
          panel={id}
          active={panel === id}
          onClick={() => useDevtoolsStore.getState().setPanel(id)}
          onContextMenu={(e) => open(id, e)}
        />
      ))}
      {node}
    </>
  );
}

/** The drawer's own tab bar + close button. */
function DrawerTabs() {
  const drawerTools = useToolsIn('drawer');
  const drawerPanel = useDevtoolsStore((s) => s.drawerPanel);
  const { open, node } = useTabMenu();
  return (
    <div className="shrink-0 h-8 flex items-center gap-0.5 px-1.5 border-b border-subtle bg-surface-2/40">
      {drawerTools.map((id) => (
        <ArrangeableTab
          key={id}
          panel={id}
          active={drawerPanel === id}
          onClick={() => useDevtoolsStore.getState().setDrawerPanel(id)}
          onContextMenu={(e) => open(id, e)}
        />
      ))}
      <div className="flex-1" />
      <button
        type="button"
        aria-label="Close drawer"
        title="Close drawer (Esc)"
        onClick={() => useDevtoolsStore.getState().setDrawerOpen(false)}
        className="size-6 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast"
      >
        <X size={14} />
      </button>
      {node}
    </div>
  );
}

/** The draggable horizontal splitter between the main area and the drawer. */
function DrawerSplitter() {
  const onDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      // The drawer grows as the pointer moves UP; measure from the dock bottom.
      // We read the nearest positioned container (the content wrapper) each move
      // so a window resize mid-drag can't drift the height.
      const wrapper = (e.target as HTMLElement).closest('[data-devtools-content]');
      const rect = wrapper?.getBoundingClientRect();
      if (!rect) return;
      const next = rect.bottom - ev.clientY;
      const max = rect.height - DRAWER_MIN; // leave room for the main area
      useDevtoolsStore.getState().setDrawerHeight(Math.min(Math.max(next, DRAWER_MIN), max));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      onPointerDown={onDown}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize drawer"
      className="shrink-0 h-1 cursor-row-resize bg-transparent hover:bg-accent/50 active:bg-accent transition-colors"
    />
  );
}

/**
 * Session-gated content: the active main panel, plus the bottom drawer when
 * open. Both the dock and the pop-out window render this beneath their headers.
 */
export function DevtoolsContent() {
  const session = useDevtoolsStore((s) => s.session);
  const panel = useDevtoolsStore((s) => s.panel);
  const drawerOpen = useDevtoolsStore((s) => s.drawerOpen);
  const drawerHeight = useDevtoolsStore((s) => s.drawerHeight);
  const drawerPanel = useDevtoolsStore((s) => s.drawerPanel);
  const mainTools = useToolsIn('main');
  const drawerTools = useToolsIn('drawer');

  // A drawer with no tools (everything moved up) collapses to closed.
  const showDrawer = drawerOpen && drawerTools.length > 0;
  // Clamp drawer height so the main area keeps DRAWER_MIN even in a short dock.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [clampedH, setClampedH] = useState(drawerHeight);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const h = el.clientHeight;
      // Before layout `clientHeight` is 0 — keep the stored height until the
      // observer reports a real size, so the drawer doesn't flash too short.
      if (h <= 0) return;
      setClampedH(Math.min(drawerHeight, Math.max(DRAWER_MIN, h - DRAWER_MIN)));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
    // `session` is a dep so the observer (re)attaches when the wrap div mounts on
    // the attaching→attached transition (the div is absent while the gate shows).
  }, [drawerHeight, session]);

  if (session === 'detached') return <Gate kind="detached" />;
  if (session === 'attaching') return <Gate kind="attaching" />;

  return (
    <div ref={wrapRef} data-devtools-content className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-hidden">
        {mainTools.length === 0 ? (
          <div className="h-full flex items-center justify-center text-caption text-fg-tertiary px-4 text-center">
            All tools are in the drawer — right-click a drawer tab and choose “Move to top”.
          </div>
        ) : (
          <PanelById panel={panel} />
        )}
      </div>
      {showDrawer ? (
        <>
          <DrawerSplitter />
          <div
            style={{ height: clampedH }}
            className="shrink-0 flex flex-col min-h-0 border-t border-subtle bg-surface-1"
          >
            <DrawerTabs />
            <div className="flex-1 min-h-0 overflow-hidden">
              <PanelById panel={drawerPanel} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Gate({ kind }: { kind: 'detached' | 'attaching' }) {
  const reason = useDevtoolsStore((s) => s.detachReason);
  if (kind === 'attaching') {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-body-sm text-fg-tertiary">
        Connecting…
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-body-sm text-fg-secondary">DevTools disconnected</p>
      {reason ? (
        <p className="text-caption text-fg-tertiary max-w-xs break-words">{reason}</p>
      ) : null}
      <button
        type="button"
        onClick={() => useDevtoolsStore.getState().reconnect()}
        className="h-7 px-3 rounded-md bg-accent-subtle/50 text-accent text-body-sm hover:bg-accent-subtle/70 transition-colors duration-fast"
      >
        Reconnect
      </button>
    </div>
  );
}
