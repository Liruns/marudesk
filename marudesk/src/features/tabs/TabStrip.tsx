import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Columns2, Copy, Globe, Lock, Plus, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useTabsStore } from './store';
import { useAgentStore } from '../agent/store';
import { useGridStore, groupForTab } from './grid';
import { leaves } from './layout';
import { confirmCloseTab, isDirty, useEditorStore } from '../editor/store';
import { tabKinds } from './registry';
import type { TabState } from '../../../shared/browser';

// Custom drag type so the strip only treats *its own* tab drags as reorders —
// a file or link dragged in carries a different type and is ignored. Also
// satisfies engines that refuse to start a drag with an empty data store.
const TAB_DND_MIME = 'application/x-marudesk-tab';

/**
 * Chrome-style tab strip. Lifted out of BrowserCanvas so the title bar (drag
 * region) can host it directly — that's what makes the chrome feel like a
 * browser instead of an IDE window with tabs inside.
 *
 * Tabs reorder by drag-and-drop: dropping a tab onto another moves it to that
 * slot. The order of record is the main-process tab map, so a reorder is
 * applied optimistically here and committed over `browser:tabs-reorder`.
 */
export function TabStrip() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const newTab = useTabsStore((s) => s.newTab);
  const reorderTabs = useTabsStore((s) => s.reorderTabs);
  // The agent tab gets a "needs you" dot when its turn parks on an approval or
  // question — so a blocked agent is visible even from another tab (Antigravity
  // "Blocked" parity).
  const agentWaiting = useAgentStore((s) => s.chat.status === 'waiting_for_user');

  const setDraggingTab = useGridStore((s) => s.setDraggingTab);
  const groups = useGridStore((s) => s.groups);
  const dissolveGroup = useGridStore((s) => s.dissolveGroup);
  const focusPane = useGridStore((s) => s.focus);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // Right-click tab menu (close/close-others/close-right/duplicate/exit-split).
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(
    null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // Which edges of the overflowing strip have more tabs hidden past them —
  // drives a soft fade mask so an overflowing strip reads as scrollable.
  const [edge, setEdge] = useState({ l: false, r: false });

  // Each split is a persistent group; consecutive strip tabs in the SAME group
  // (kept contiguous by grid.syncStripGrouping) are bracketed as one merged
  // block. Because the group persists across tab switches, so does the merge.
  const groupIdOf = (tabId: string): string | null =>
    groupForTab(groups, tabId)?.id ?? null;

  const resetDrag = () => {
    setDraggingId(null);
    setOverId(null);
    // Tear down the seed-the-grid drop overlay (and re-show the web view).
    setDraggingTab(null);
  };

  const commitReorder = (targetId: string) => {
    if (!draggingId || draggingId === targetId) {
      resetDrag();
      return;
    }
    // Read the live order at drop time — a background tab finishing load can
    // push a new snapshot mid-drag, making the render-closure `tabs` stale.
    const ids = useTabsStore.getState().tabs.map((t) => t.id);
    const from = ids.indexOf(draggingId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) {
      resetDrag();
      return;
    }
    ids.splice(from, 1);
    ids.splice(to, 0, draggingId);
    reorderTabs(ids);
    resetDrag();
  };

  // Keep the active tab in view when the strip overflows horizontally (many
  // tabs scroll the strip; activating an off-screen one should reveal it).
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      '[data-tab-active="true"]',
    );
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  // Track which edges have hidden tabs so the strip can fade them (scroll cue).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setEdge({ l: el.scrollLeft > 1, r: el.scrollLeft < max - 1 });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [tabs.length, groups]);

  // Dismiss the context menu on Escape (outside-click is handled by its backdrop).
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // Close a set of tabs, honoring the unsaved-changes confirm for dirty editors.
  const closeMany = (ids: string[]) => {
    const byId = new Map(tabs.map((t) => [t.id, t] as const));
    for (const id of ids) {
      const t = byId.get(id);
      if (t && confirmCloseTab(t)) void closeTab(id);
    }
  };

  // Activating a tab that lives in a split also focuses its pane, so clicking a
  // grouped chip highlights the right pane instead of just showing the group.
  const focusTabPane = (tabId: string) => {
    const g = groupForTab(groups, tabId);
    if (!g) return;
    const leaf = leaves(g).find((l) => l.tabId === tabId);
    if (leaf) focusPane(leaf.id);
  };

  const renderChip = (tab: TabState, grouped = false) => (
    <TabChip
      key={tab.id}
      tab={tab}
      active={tab.id === activeTabId}
      attention={tab.kind === 'agent' && agentWaiting}
      grouped={grouped}
      dragging={tab.id === draggingId}
      dropTarget={
        tab.id === overId && draggingId !== null && draggingId !== tab.id
      }
      onActivate={() => {
        void activateTab(tab.id);
        focusTabPane(tab.id);
      }}
      onContextMenu={(x, y) => setMenu({ tabId: tab.id, x, y })}
      onClose={() => {
        if (confirmCloseTab(tab)) void closeTab(tab.id);
      }}
      canClose={tabs.length > 1}
      onDragStart={() => {
        setDraggingId(tab.id);
        setDraggingTab(tab.id);
      }}
      onDragEnter={() => {
        if (draggingId && draggingId !== tab.id) setOverId(tab.id);
      }}
      onDrop={() => commitReorder(tab.id)}
      onDragEnd={resetDrag}
    />
  );

  // Walk the strip, bracketing each contiguous run of same-group tabs into one
  // SplitGroup; standalone tabs (and a lone non-contiguous group member) render
  // as plain chips.
  const stripNodes: ReactNode[] = [];
  let run: TabState[] = [];
  let runGroupId: string | null = null;
  const flushRun = () => {
    if (run.length === 0) return;
    if (runGroupId && run.length >= 2) {
      const exitId = run[0].id;
      stripNodes.push(
        <SplitGroup key={`split-${runGroupId}`} onExit={() => dissolveGroup(exitId)}>
          {run.map((t) => renderChip(t, true))}
        </SplitGroup>,
      );
    } else {
      for (const t of run) stripNodes.push(renderChip(t));
    }
    run = [];
    runGroupId = null;
  };
  for (const tab of tabs) {
    const gid = groupIdOf(tab.id);
    if (gid && gid === runGroupId) {
      run.push(tab);
    } else {
      flushRun();
      run = [tab];
      runGroupId = gid;
    }
  }
  flushRun();

  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : undefined;

  // Soft fade over whichever edge(s) hide more tabs — purely a scroll affordance.
  const F = 28;
  const maskImage =
    edge.l && edge.r
      ? `linear-gradient(90deg, transparent 0, #000 ${F}px, #000 calc(100% - ${F}px), transparent 100%)`
      : edge.l
        ? `linear-gradient(90deg, transparent 0, #000 ${F}px)`
        : edge.r
          ? `linear-gradient(90deg, #000 calc(100% - ${F}px), transparent 100%)`
          : undefined;

  return (
    // Chrome-style strip: vertically-centered floating pills that grow to share
    // the bar (flex-1, capped per chip) and shrink equally as more open, then
    // scroll. The "+" button is the last interactive child so it hugs the right
    // edge of the final tab; a trailing flex-1 filler (re-armed as a drag region
    // since its parent opts out) eats whatever width is left so the empty stretch
    // past the last tab still moves the window.
    <div className="flex items-center flex-1 min-w-0 h-full pl-1.5">
      <div
        ref={scrollRef}
        className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto scrollbar-none no-drag"
        style={{ maskImage, WebkitMaskImage: maskImage }}
      >
        {stripNodes}
        <button
          type="button"
          onClick={() => void newTab()}
          className={cn(
            'size-7 rounded-md flex items-center justify-center shrink-0 ml-0.5',
            'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2',
            'transition-colors duration-fast',
          )}
          aria-label="New tab"
          title="New tab (Ctrl+T)"
        >
          <Plus size={16} />
        </button>
        <div className="drag-region flex-1 self-stretch min-w-[12px]" aria-hidden />
      </div>
      {menu && menuTab ? (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildMenuItems({
            tab: menuTab,
            tabs,
            inGroup: !!groupIdOf(menu.tabId),
            closeMany,
            duplicate: () => void newTab('web', menuTab.url),
            exitSplit: () => dissolveGroup(menu.tabId),
          })}
        />
      ) : null}
    </div>
  );
}

type TabMenuItem = {
  key: string;
  label: string;
  icon?: typeof Copy;
  disabled?: boolean;
  onClick: () => void;
};

/** Build the right-click menu entries for a tab. */
function buildMenuItems({
  tab,
  tabs,
  inGroup,
  closeMany,
  duplicate,
  exitSplit,
}: {
  tab: TabState;
  tabs: TabState[];
  inGroup: boolean;
  closeMany: (ids: string[]) => void;
  duplicate: () => void;
  exitSplit: () => void;
}): TabMenuItem[] {
  const idx = tabs.findIndex((t) => t.id === tab.id);
  const others = tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
  const toRight = tabs.slice(idx + 1).map((t) => t.id);
  return [
    { key: 'close', label: 'Close', icon: X, onClick: () => closeMany([tab.id]) },
    {
      key: 'others',
      label: 'Close others',
      disabled: others.length === 0,
      onClick: () => closeMany(others),
    },
    {
      key: 'right',
      label: 'Close tabs to the right',
      disabled: toRight.length === 0,
      onClick: () => closeMany(toRight),
    },
    ...(tab.kind === 'web'
      ? [{ key: 'dup', label: 'Duplicate', icon: Copy, onClick: duplicate }]
      : []),
    ...(inGroup
      ? [{ key: 'exit', label: 'Exit split', icon: Columns2, onClick: exitSplit }]
      : []),
  ];
}

/**
 * Lightweight right-click menu for a tab. A full-screen backdrop captures the
 * dismiss click (and a right-click elsewhere); the menu itself stops propagation.
 * Anchored at the cursor — the strip sits at the top of the window, so it always
 * has room to open downward.
 */
function TabContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: TabMenuItem[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        role="menu"
        className={cn(
          'absolute min-w-[190px] rounded-md py-1 no-drag',
          'border border-subtle bg-surface-2 shadow-lg shadow-black/30',
        )}
        style={{ top: y, left: x }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                if (it.disabled) return;
                it.onClick();
                onClose();
              }}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-left text-caption',
                'transition-colors duration-fast',
                it.disabled
                  ? 'text-fg-tertiary/50 cursor-default'
                  : 'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
              )}
            >
              {Icon ? (
                <Icon size={13} className="shrink-0" aria-hidden />
              ) : (
                <span className="size-[13px] shrink-0" aria-hidden />
              )}
              <span className="flex-1 truncate">{it.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Visual bracket around the tiled tabs of a split. The leading glyph doubles as
 * an "exit split" control (collapses the grid back to the focused single tab),
 * giving the strip a way to dissolve a split to match the way it shows one.
 */
function SplitGroup({
  children,
  onExit,
}: {
  children: ReactNode;
  onExit: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Split view group"
      className={cn(
        // A rounded tinted capsule (one step up from the bar) wraps the merged
        // tiles as one block; the faint accent ring is the single grouping cue,
        // and the inset px frame lets the tint read as a border around the pills.
        'group/split relative flex items-center gap-0.5 h-8 px-1 rounded-lg shrink-0',
        'bg-surface-2/60 ring-1 ring-inset ring-accent/25 no-drag',
      )}
    >
      <button
        type="button"
        onClick={onExit}
        aria-label="Exit split view"
        title="Exit split view"
        className={cn(
          'size-5 rounded flex items-center justify-center shrink-0',
          'text-accent/70 hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
        )}
      >
        <Columns2 size={12} />
      </button>
      {children}
    </div>
  );
}

function TabChip({
  tab,
  active,
  attention,
  grouped,
  onActivate,
  onContextMenu,
  onClose,
  canClose,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd,
}: {
  tab: TabState;
  active: boolean;
  attention?: boolean;
  grouped?: boolean;
  onActivate: () => void;
  onContextMenu: (x: number, y: number) => void;
  onClose: () => void;
  canClose: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const label = tab.title.trim() || prettyUrl(tab.url) || 'New tab';
  const dirty = useEditorStore((s) =>
    tab.kind === 'editor' && tab.filePath
      ? isDirty(s.files[tab.filePath])
      : false,
  );
  const onCloseClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onClose();
  };
  const onMiddleDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button === 1 && canClose) {
      e.preventDefault();
      onClose();
    }
  };
  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-active={active}
      draggable
      onClick={onActivate}
      onMouseDown={onMiddleDown}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(TAB_DND_MIME, tab.id);
        onDragStart();
      }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TAB_DND_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(TAB_DND_MIME)) return;
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      title={tab.url || label}
      className={cn(
        // Floating pill (GM3-style): rounded on every corner, vertically centered
        // in the bar. `grow-0 basis` + min-w makes tabs share width and shrink
        // equally as more open (Chrome's equal-distribution), scrolling past the
        // floor. Grouped chips are shorter so the split capsule frames them.
        'group relative flex items-center gap-2 pl-3 pr-1.5 rounded-md',
        'text-caption cursor-default select-none transition-colors duration-fast',
        grouped
          ? 'h-7 grow-0 basis-[170px] min-w-[64px]'
          : 'h-8 flex-1 basis-0 min-w-[80px] max-w-[240px]',
        active
          ? grouped
            ? 'bg-surface-3 text-fg-primary'
            : 'bg-surface-2 text-fg-primary'
          : grouped
            ? 'bg-transparent text-fg-secondary hover:text-fg-primary hover:bg-surface-3/50'
            : 'bg-transparent text-fg-secondary hover:text-fg-primary hover:bg-surface-2/50',
        dragging ? 'opacity-40' : '',
      )}
    >
      {dropTarget ? (
        <span
          aria-hidden
          className="absolute -left-1 top-1 bottom-1 w-0.5 rounded-pill bg-accent"
        />
      ) : null}
      <TabIndicator tab={tab} />
      <span className="flex-1 min-w-0 truncate font-medium">{label}</span>
      {attention ? (
        <span
          aria-hidden
          title="Agent needs your input"
          className="size-1.5 rounded-pill bg-warning animate-pulse shrink-0"
        />
      ) : null}
      {canClose ? (
        <button
          type="button"
          onClick={onCloseClick}
          aria-label={dirty ? 'Unsaved — close tab' : 'Close tab'}
          title={dirty ? 'Unsaved changes — close tab' : 'Close tab'}
          className={cn(
            'size-5 rounded flex items-center justify-center shrink-0',
            'text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary',
            dirty || active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          {dirty ? (
            <>
              <span
                aria-hidden
                className="size-2 rounded-pill bg-fg-secondary group-hover:hidden"
              />
              <X size={12} className="hidden group-hover:block" />
            </>
          ) : (
            <X size={12} />
          )}
        </button>
      ) : dirty ? (
        <span
          className="size-5 shrink-0 flex items-center justify-center"
          aria-hidden
        >
          <span className="size-2 rounded-pill bg-fg-secondary" />
        </span>
      ) : (
        <span className="size-5 shrink-0" aria-hidden />
      )}
    </div>
  );
}

function TabIndicator({ tab }: { tab: TabState }) {
  // Feature tabs read differently from web tabs: a monochrome accent glyph (from
  // the shared tab-kind registry). Web tabs show the live favicon when we have
  // one, falling back to a security glyph (spinner while loading / lock / globe).
  if (tab.kind !== 'web') {
    const Icon = tabKinds[tab.kind].icon;
    return (
      <span className="text-accent shrink-0" aria-hidden>
        <Icon size={14} />
      </span>
    );
  }
  // Loading wins over the favicon (Chrome-style): a quiet accent spinner ring
  // signals progress. Reduced-motion freezes it to a static ring (no shimmer).
  if (tab.isLoading) {
    return (
      <span
        aria-hidden
        className="size-4 shrink-0 rounded-full border-2 border-accent/25 border-t-accent animate-spin motion-reduce:animate-none"
      />
    );
  }
  // Real favicon (a CSP-safe data URL inlined by main). A decode failure falls
  // through to the globe. `key` remounts on a source change so a tab that
  // recovers from a bad icon on its next navigation re-attempts the image.
  if (tab.favicon) {
    return <FaviconImg key={tab.favicon} src={tab.favicon} />;
  }
  if (!tab.url || tab.url === 'about:blank') {
    return (
      <span className="text-fg-tertiary shrink-0" aria-hidden>
        <Globe size={14} />
      </span>
    );
  }
  if (tab.isSecure) {
    return (
      <span className="text-fg-secondary shrink-0" aria-hidden>
        <Lock size={14} />
      </span>
    );
  }
  return (
    <span className="text-warning shrink-0" aria-hidden>
      <Globe size={14} />
    </span>
  );
}

function FaviconImg({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="text-fg-tertiary shrink-0" aria-hidden>
        <Globe size={14} />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      className="size-4 shrink-0 rounded-[3px] object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function prettyUrl(url: string): string {
  if (!url || url === 'about:blank') return '';
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}
