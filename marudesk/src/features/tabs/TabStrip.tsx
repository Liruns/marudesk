import { useState, type MouseEvent, type ReactNode } from 'react';
import { Columns2, Globe, Lock, Plus, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useTabsStore } from './store';
import { useGridStore, groupForTab } from './grid';
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

  const setDraggingTab = useGridStore((s) => s.setDraggingTab);
  const groups = useGridStore((s) => s.groups);
  const dissolveGroup = useGridStore((s) => s.dissolveGroup);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

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

  const renderChip = (tab: TabState) => (
    <TabChip
      key={tab.id}
      tab={tab}
      active={tab.id === activeTabId}
      dragging={tab.id === draggingId}
      dropTarget={
        tab.id === overId && draggingId !== null && draggingId !== tab.id
      }
      onActivate={() => void activateTab(tab.id)}
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
          {run.map(renderChip)}
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

  return (
    <div className="flex items-end gap-0.5 flex-1 min-w-0 h-full pt-1.5">
      <div className="flex items-end gap-0.5 flex-1 min-w-0 overflow-x-auto scrollbar-none no-drag">
        {stripNodes}
      </div>
      <button
        type="button"
        onClick={() => void newTab()}
        className={cn(
          'size-7 rounded flex items-center justify-center shrink-0 no-drag',
          'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2',
          'transition-colors duration-fast mb-1',
        )}
        aria-label="New tab"
        title="New tab (Ctrl+T)"
      >
        <Plus size={14} />
      </button>
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
        'group/split flex items-end gap-0.5 self-stretch pl-1 pr-1 rounded-t-lg',
        // Neutral, hairline-bracketed container (not a loud accent fill) so a
        // split reads as a quiet grouping of its tabs rather than a colored box.
        'bg-surface-2/40 ring-1 ring-inset ring-subtle no-drag',
      )}
    >
      <button
        type="button"
        onClick={onExit}
        aria-label="Exit split view"
        title="Exit split view"
        className={cn(
          'self-center mr-0.5 size-5 rounded flex items-center justify-center shrink-0',
          'text-fg-tertiary hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
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
  onActivate,
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
  onActivate: () => void;
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
      draggable
      onClick={onActivate}
      onMouseDown={onMiddleDown}
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
        'group relative h-8 max-w-[220px] min-w-[120px] rounded-t-md flex items-center gap-2 pl-3 pr-1.5',
        'text-caption cursor-default select-none border-t border-x',
        'transition-colors duration-fast',
        active
          ? 'bg-surface-1 border-subtle text-fg-primary'
          : 'bg-transparent border-transparent text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2/40',
        dragging ? 'opacity-40' : '',
      )}
    >
      {dropTarget ? (
        <span
          aria-hidden
          className="absolute left-0 top-1 bottom-1 w-0.5 rounded-pill bg-accent"
        />
      ) : null}
      <TabIndicator tab={tab} />
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {canClose ? (
        <button
          type="button"
          onClick={onCloseClick}
          aria-label={dirty ? 'Unsaved — close tab' : 'Close tab'}
          title={dirty ? 'Unsaved changes — close tab' : 'Close tab'}
          className={cn(
            'size-5 rounded flex items-center justify-center shrink-0',
            'text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary',
            dirty ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            !dirty && active ? 'opacity-60' : '',
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
        <Icon size={12} />
      </span>
    );
  }
  // Loading wins over the favicon (Chrome-style): the spinner signals progress.
  if (tab.isLoading) {
    return (
      <span
        aria-hidden
        className="size-2 rounded-pill bg-accent animate-pulse shrink-0"
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
        <Globe size={12} />
      </span>
    );
  }
  if (tab.isSecure) {
    return (
      <span className="text-fg-secondary shrink-0" aria-hidden>
        <Lock size={12} />
      </span>
    );
  }
  return (
    <span className="text-warning shrink-0" aria-hidden>
      <Globe size={12} />
    </span>
  );
}

function FaviconImg({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="text-fg-tertiary shrink-0" aria-hidden>
        <Globe size={12} />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      className="size-3.5 shrink-0 rounded-[2px] object-contain"
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
