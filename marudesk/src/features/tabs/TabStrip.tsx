import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pencil, Plus, Ungroup, X } from 'lucide-react';
import type {
  TabGroup,
  TabGroupColor,
  TabState,
} from '../../../shared/browser';
import type { WorkspaceId } from '../../../shared/workspace';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { useAgentStore } from '../agent/store';
import { confirmCloseTab } from '../editor/store';
import { groupForTab, useGridStore } from './grid';
import { leaves } from './layout';
import { SplitGroup } from './SplitGroup';
import { TabChip, type TabChipLabels } from './TabChip';
import { TabGroupChip, type TabGroupChipLabels } from './TabGroupChip';
import { TabGroupMenu, type TabGroupMenuItem } from './TabGroupMenu';
import { TabStripMenu } from './TabStripMenu';
import { buildTabMenuItems, type TabStripMenuLabels } from './tabMenuItems';
import { useTabsStore } from './store';
import { useCanvasOwnedTabIds } from '../canvas/store';

type MenuState = { readonly tabId: string; readonly x: number; readonly y: number };
type ChipMenuState = {
  readonly groupId: string;
  readonly x: number;
  readonly y: number;
};

export function TabStrip({ workspaceId }: { workspaceId?: WorkspaceId } = {}) {
  const { t } = useI18n();
  const tabs = useTabsStore((s) => s.tabs);
  // Cards living on the infinite canvas are owned by that surface — keep their
  // chips out of the classic strip so the two surfaces stay separate.
  const canvasOwned = useCanvasOwnedTabIds();
  const scopedTabs = (workspaceId ? tabs.filter((tab) => tab.workspaceId === workspaceId) : tabs).filter(
    (tab) => !canvasOwned.has(tab.id),
  );
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTabIdsByWorkspace = useTabsStore((s) => s.activeTabIdsByWorkspace);
  const activateTab = useTabsStore((s) => s.activateTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const newTab = useTabsStore((s) => s.newTab);
  const moveTab = useTabsStore((s) => s.moveTab);
  const setPinned = useTabsStore((s) => s.setPinned);
  // Chrome-style tab groups (mirrored from main) — distinct from the grid
  // store's split-view `groups` below.
  const tabGroups = useTabsStore((s) => s.groups);
  const createTabGroup = useTabsStore((s) => s.createTabGroup);
  const addTabToTabGroup = useTabsStore((s) => s.addTabToTabGroup);
  const removeTabFromTabGroup = useTabsStore((s) => s.removeTabFromTabGroup);
  const updateTabGroup = useTabsStore((s) => s.updateTabGroup);
  const setTabGroupCollapsed = useTabsStore((s) => s.setTabGroupCollapsed);
  const dissolveTabGroup = useTabsStore((s) => s.dissolveTabGroup);
  const closeTabGroup = useTabsStore((s) => s.closeTabGroup);
  const newTabInTabGroup = useTabsStore((s) => s.newTabInTabGroup);
  const agentWaiting = useAgentStore((s) => s.chat.status === 'waiting_for_user');
  const setDraggingTab = useGridStore((s) => s.setDraggingTab);
  const groups = useGridStore((s) => s.groups);
  const dissolveGroup = useGridStore((s) => s.dissolveGroup);
  const focusPane = useGridStore((s) => s.focus);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [chipMenu, setChipMenu] = useState<ChipMenuState | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ l: false, r: false });
  const preferredActiveTabId = workspaceId
    ? (activeTabIdsByWorkspace[workspaceId] ?? activeTabId)
    : activeTabId;
  const scopedActiveTabId = scopedTabs.some((tab) => tab.id === preferredActiveTabId)
    ? preferredActiveTabId
    : (scopedTabs[0]?.id ?? null);

  const chipLabels: TabChipLabels = {
    agentNeedsInput: t('tabStrip.agentNeedsInput'),
    closeTab: t('tabStrip.closeTab'),
    newTabFallback: t('tabStrip.newTab'),
    unsavedChangesCloseTab: t('tabStrip.unsavedChangesCloseTab'),
    unsavedCloseTab: t('tabStrip.unsavedCloseTab'),
  };
  const menuLabels: TabStripMenuLabels = {
    close: t('tabStrip.menu.close'),
    closeOthers: t('tabStrip.menu.closeOthers'),
    closeRight: t('tabStrip.menu.closeRight'),
    duplicate: t('tabStrip.menu.duplicate'),
    exitSplit: t('tabStrip.menu.exitSplit'),
    pin: t('tabStrip.menu.pin'),
    unpin: t('tabStrip.menu.unpin'),
    addToNewGroup: t('tabStrip.menu.addToNewGroup'),
    addToGroup: t('tabStrip.menu.addToGroup'),
    removeFromGroup: t('tabStrip.menu.removeFromGroup'),
    newTabInGroup: t('tabStrip.menu.newTabInGroup'),
    unnamedGroup: t('tabGroup.unnamed'),
  };
  const splitLabels = {
    group: t('tabStrip.splitGroup'),
    exit: t('tabStrip.exitSplitView'),
  };
  const groupChipLabels: TabGroupChipLabels = {
    tabGroup: t('tabGroup.chipAria'),
    unnamed: t('tabGroup.unnamed'),
    renamePlaceholder: t('tabGroup.renamePlaceholder'),
  };
  const groupColorLabels: Readonly<Record<TabGroupColor, string>> = {
    violet: t('tabGroup.color.violet'),
    blue: t('tabGroup.color.blue'),
    teal: t('tabGroup.color.teal'),
    green: t('tabGroup.color.green'),
    amber: t('tabGroup.color.amber'),
    rose: t('tabGroup.color.rose'),
  };

  const groupIdOf = (tabId: string): string | null =>
    groupForTab(groups, tabId)?.id ?? null;

  const resetDrag = () => {
    setDraggingId(null);
    setOverId(null);
    setDraggingTab(null);
  };

  const commitReorder = (targetId: string) => {
    if (!draggingId || draggingId === targetId) {
      resetDrag();
      return;
    }
    // Membership-aware move (browser:tabs-move): dropping inside a tab group's
    // span joins the group, dragging a member out of its span leaves it — main
    // applies the same shared moveTabAmongGroups policy authoritatively.
    moveTab(draggingId, targetId);
    resetDrag();
  };

  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>('[data-tab-active="true"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [scopedActiveTabId, scopedTabs.length]);

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
  }, [scopedTabs.length, groups, tabGroups]);

  useEffect(() => {
    if (!menu && !chipMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setChipMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, chipMenu]);

  const closeMany = (ids: readonly string[]) => {
    const byId = new Map(scopedTabs.map((t) => [t.id, t] as const));
    for (const id of ids) {
      const tab = byId.get(id);
      if (tab && confirmCloseTab(tab)) void closeTab(id);
    }
  };

  const focusTabPane = (tabId: string) => {
    const group = groupForTab(groups, tabId);
    if (!group) return;
    const leaf = leaves(group).find((l) => l.tabId === tabId);
    if (leaf) focusPane(leaf.id);
  };

  const renderChip = (
    tab: TabState,
    grouped = false,
    tabGroupColor?: TabGroupColor,
  ) => (
    <TabChip
      key={tab.id}
      tab={tab}
      active={tab.id === scopedActiveTabId}
      attention={tab.kind === 'agent' && agentWaiting}
      grouped={grouped}
      pinned={!grouped && tab.pinned}
      {...(tabGroupColor ? { tabGroupColor } : {})}
      dragging={tab.id === draggingId}
      dropTarget={
        tab.id === overId && draggingId !== null && draggingId !== tab.id
      }
      labels={chipLabels}
      onActivate={() => {
        void activateTab(tab.id);
        focusTabPane(tab.id);
      }}
      onContextMenu={(x, y) => setMenu({ tabId: tab.id, x, y })}
      onClose={() => {
        if (confirmCloseTab(tab)) void closeTab(tab.id);
      }}
      canClose={true}
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

  const tabGroupById = new Map(tabGroups.map((g) => [g.id, g] as const));
  const tabGroupOf = (tab: TabState): TabGroup | undefined =>
    tab.groupId ? tabGroupById.get(tab.groupId) : undefined;

  const stripNodes: ReactNode[] = [];
  // Split-view run buffer (grid feature — unrelated to tab groups).
  let run: TabState[] = [];
  let runGroupId: string | null = null;
  const flushRun = () => {
    if (run.length === 0) return;
    if (runGroupId && run.length >= 2) {
      const exitId = run[0]?.id;
      if (!exitId) return;
      stripNodes.push(
        <SplitGroup
          key={`split-${runGroupId}`}
          labels={splitLabels}
          onExit={() => dissolveGroup(exitId)}
        >
          {run.map((tab) => renderChip(tab, true))}
        </SplitGroup>,
      );
    } else {
      for (const tab of run) stripNodes.push(renderChip(tab));
    }
    run = [];
    runGroupId = null;
  };

  // Tab-group run buffer: the colored header chip precedes the group's member
  // chips; a collapsed group renders the chip only (members hidden from the
  // strip but still in the registry — activating one expands the group in main).
  let tabGroupRun: TabState[] = [];
  let runTabGroup: TabGroup | null = null;
  const flushTabGroup = () => {
    const group = runTabGroup;
    if (!group) return;
    stripNodes.push(
      <TabGroupChip
        key={`tabgroup-${group.id}`}
        group={group}
        memberCount={tabGroupRun.length}
        renaming={renamingGroupId === group.id}
        labels={groupChipLabels}
        onToggleCollapse={() =>
          void setTabGroupCollapsed(group.id, !group.collapsed)
        }
        onContextMenu={(x, y) => setChipMenu({ groupId: group.id, x, y })}
        onRenameCommit={(name) => {
          setRenamingGroupId(null);
          void updateTabGroup(group.id, { name });
        }}
        onRenameCancel={() => setRenamingGroupId(null)}
      />,
    );
    if (!group.collapsed) {
      for (const tab of tabGroupRun) {
        stripNodes.push(renderChip(tab, false, group.color));
      }
    }
    tabGroupRun = [];
    runTabGroup = null;
  };

  for (const tab of scopedTabs) {
    const tabGroup = tabGroupOf(tab);
    if (tabGroup) {
      // Tab-group membership wins over the split-view wrapper in the strip
      // (the grid split itself is untouched; only the chrome-panel chrome is
      // skipped for tabs that live inside a tab group).
      flushRun();
      if (runTabGroup?.id === tabGroup.id) {
        tabGroupRun.push(tab);
      } else {
        flushTabGroup();
        runTabGroup = tabGroup;
        tabGroupRun = [tab];
      }
      continue;
    }
    flushTabGroup();
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
  flushTabGroup();

  const menuTab = menu ? scopedTabs.find((t) => t.id === menu.tabId) : undefined;
  const chipMenuGroup = chipMenu
    ? tabGroups.find((g) => g.id === chipMenu.groupId)
    : undefined;
  const chipMenuItems: TabGroupMenuItem[] = chipMenuGroup
    ? [
        {
          key: 'rename',
          label: t('tabGroup.rename'),
          icon: Pencil,
          onClick: () => setRenamingGroupId(chipMenuGroup.id),
        },
        {
          key: 'ungroup',
          label: t('tabGroup.ungroup'),
          icon: Ungroup,
          onClick: () => void dissolveTabGroup(chipMenuGroup.id),
        },
        {
          key: 'close-group',
          label: t('tabGroup.closeGroup'),
          icon: X,
          onClick: () => void closeTabGroup(chipMenuGroup.id),
        },
      ]
    : [];
  const maskImage = tabStripMask(edge.l, edge.r);

  return (
    <div data-tour="tabs" className="flex items-center flex-1 min-w-0 h-full pl-1.5">
      <div
        ref={scrollRef}
        role="tablist"
        aria-label={t('tabStrip.openTabs')}
        aria-orientation="horizontal"
        className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto scrollbar-none no-drag"
        style={{ maskImage, WebkitMaskImage: maskImage }}
      >
        {stripNodes}
        <button
          type="button"
          onClick={() => void newTab('home', undefined, workspaceId)}
          className={cn(
            'size-7 rounded-md flex items-center justify-center shrink-0 ml-0.5',
            'text-fg-tertiary hover:text-fg-primary hover:bg-surface-2',
            'transition-colors duration-fast',
          )}
          aria-label={t('tabStrip.newTab')}
          title={t('tabStrip.newTabTitle')}
        >
          <Plus size={16} />
        </button>
        <div className="drag-region flex-1 self-stretch min-w-[12px]" aria-hidden />
      </div>
      {menu && menuTab ? (
        <TabStripMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildTabMenuItems({
            tab: menuTab,
            tabs: scopedTabs,
            inGroup: !!groupIdOf(menu.tabId),
            tabGroups: tabGroups.filter(
              (g) => g.workspaceId === menuTab.workspaceId,
            ),
            labels: menuLabels,
            closeMany,
            duplicate: () => void newTab('web', menuTab.url, workspaceId),
            exitSplit: () => dissolveGroup(menu.tabId),
            togglePin: () => void setPinned(menu.tabId, !menuTab.pinned),
            addToNewTabGroup: () => void createTabGroup(menuTab.id),
            addToTabGroup: (groupId) =>
              void addTabToTabGroup(menuTab.id, groupId),
            removeFromTabGroup: () => void removeTabFromTabGroup(menuTab.id),
            newTabInTabGroup: (groupId) =>
              void newTabInTabGroup(groupId, menuTab.workspaceId),
          })}
        />
      ) : null}
      {chipMenu && chipMenuGroup ? (
        <TabGroupMenu
          x={chipMenu.x}
          y={chipMenu.y}
          color={chipMenuGroup.color}
          colorRowLabel={t('tabGroup.colorLabel')}
          colorLabels={groupColorLabels}
          items={chipMenuItems}
          onPickColor={(color) =>
            void updateTabGroup(chipMenuGroup.id, { color })
          }
          onClose={() => setChipMenu(null)}
        />
      ) : null}
    </div>
  );
}

function tabStripMask(left: boolean, right: boolean): string | undefined {
  const fadeWidth = 28;
  if (left && right) {
    return `linear-gradient(90deg, transparent 0, #000 ${fadeWidth}px, #000 calc(100% - ${fadeWidth}px), transparent 100%)`;
  }
  if (left) return `linear-gradient(90deg, transparent 0, #000 ${fadeWidth}px)`;
  if (right) {
    return `linear-gradient(90deg, #000 calc(100% - ${fadeWidth}px), transparent 100%)`;
  }
  return undefined;
}
