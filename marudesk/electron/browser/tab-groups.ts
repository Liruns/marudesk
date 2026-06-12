import { randomUUID } from 'node:crypto';
import type { TabGroup, TabGroupColor } from '../../shared/browser';
import type { WorkspaceId } from '../../shared/workspace';
import {
  addTabToGroupEntries,
  applyScopedOrder,
  assignGroup,
  dissolveGroupEntries,
  groupMemberIds,
  moveTabAmongGroups,
  nearestOutsideGroup,
  nextGroupColor,
  removeTabFromGroupEntries,
  type GroupEntry,
} from '../../shared/tab-groups';
import {
  getActiveTabId,
  getTab,
  getTabGroup,
  pruneEmptyTabGroups,
  pushState,
  reorderTabRecords,
  setTabGroup,
  tabGroupValues,
  tabKeys,
  tabValues,
} from './state';
import { pinnedFirst } from './tab-order.ts';
import { activateTab, closeTab } from './tabs';
import { saveTabSession } from './tab-session';

/**
 * Tab-group verbs (Chrome-style tab groups): create-from-tab, add/remove
 * membership, rename/recolor, collapse, dissolve, close, and the membership-
 * aware drag move. Main owns the group records (electron/browser/state.ts)
 * exactly like tab records; every verb ends in `pushState()` so the renderer
 * store stays a mirror, and in `saveTabSession()` so groups survive a restart.
 *
 * The order/membership math lives in shared/tab-groups.ts (pure, unit-tested);
 * this module binds it to the live tab map. Groups are scoped to ONE workspace
 * — all membership inference runs over that workspace's entries and is merged
 * back into the full tab order via `applyScopedOrder`.
 */

/** The workspace's tabs as pure group entries, in authoritative tab order. */
function scopedEntries(workspaceId: WorkspaceId): GroupEntry[] {
  return tabValues()
    .filter((rec) => rec.workspaceId === workspaceId)
    .map((rec) => ({ id: rec.id, groupId: rec.groupId ?? null }));
}

/** Write entries (membership + scoped order) back into the live tab map. */
function applyEntries(entries: readonly GroupEntry[]): void {
  for (const entry of entries) {
    const rec = getTab(entry.id);
    if (rec) rec.groupId = entry.groupId ?? undefined;
  }
  reorderTabRecords(
    pinnedFirst(applyScopedOrder(tabKeys(), entries.map((e) => e.id))),
  );
  pruneEmptyTabGroups();
}

/** A tab is hidden from the strip when its group is collapsed. */
export function isTabHiddenByCollapse(tabId: string): boolean {
  const rec = getTab(tabId);
  if (!rec || !rec.groupId) return false;
  return getTabGroup(rec.groupId)?.collapsed === true;
}

function commit(): void {
  pushState();
  saveTabSession();
}

/**
 * Create a new group containing exactly `tabId` (Chrome's "Add tab to new
 * group"), picking the next free palette color. A grouped tab moves to the new
 * group; a pinned tab is refused. Returns the new group id, or null.
 */
export function createTabGroupFromTab(
  tabId: string,
  name = '',
  color?: TabGroupColor,
): string | null {
  const rec = getTab(tabId);
  if (!rec || rec.pinned) return null;
  const used = tabGroupValues()
    .filter((g) => g.workspaceId === rec.workspaceId)
    .map((g) => g.color);
  const group: TabGroup = {
    id: randomUUID(),
    workspaceId: rec.workspaceId,
    name,
    color: color ?? nextGroupColor(used),
    collapsed: false,
  };
  setTabGroup(group);
  applyEntries(assignGroup(scopedEntries(rec.workspaceId), tabId, group.id));
  commit();
  return group.id;
}

/**
 * Add `tabId` to an existing group: membership set and the tab moved to the
 * end of the group's span. Expands a collapsed target group (Chrome does the
 * same — the freshly added tab must be visible). Pinned tabs are refused.
 */
export function addTabToGroup(tabId: string, groupId: string): boolean {
  const rec = getTab(tabId);
  const group = getTabGroup(groupId);
  if (!rec || !group || rec.pinned) return false;
  if (rec.workspaceId !== group.workspaceId) return false;
  if (group.collapsed) setTabGroup({ ...group, collapsed: false });
  applyEntries(addTabToGroupEntries(scopedEntries(rec.workspaceId), tabId, groupId));
  commit();
  return true;
}

/**
 * Remove `tabId` from its group; the tab re-slots just after the group's span
 * so a mid-group removal can't split the run. No-op for ungrouped tabs.
 */
export function removeTabFromGroup(tabId: string): boolean {
  const rec = getTab(tabId);
  if (!rec || !rec.groupId) return false;
  applyEntries(removeTabFromGroupEntries(scopedEntries(rec.workspaceId), tabId));
  commit();
  return true;
}

/** Rename and/or recolor a group. Empty name = unnamed (color dot only). */
export function updateTabGroup(
  groupId: string,
  patch: { name?: string; color?: TabGroupColor },
): boolean {
  const group = getTabGroup(groupId);
  if (!group) return false;
  setTabGroup({
    ...group,
    name: patch.name ?? group.name,
    color: patch.color ?? group.color,
  });
  commit();
  return true;
}

/**
 * Collapse/expand a group. Collapsing the group that holds the active tab
 * activates the nearest visible tab outside the group (right, then left —
 * Chrome's policy); when no other visible tab exists in the workspace the
 * collapse is refused, so the active tab can never be hidden.
 */
export function setTabGroupCollapsed(
  groupId: string,
  collapsed: boolean,
): boolean {
  const group = getTabGroup(groupId);
  if (!group || group.collapsed === collapsed) return group !== undefined;
  const activeId = getActiveTabId();
  const active = activeId ? getTab(activeId) : null;
  if (collapsed && active && active.groupId === groupId) {
    const entries = scopedEntries(group.workspaceId);
    const fallback = nearestOutsideGroup(
      entries,
      groupId,
      (id) => !isTabHiddenByCollapse(id),
    );
    if (!fallback) return false;
    setTabGroup({ ...group, collapsed: true });
    activateTab(fallback); // pushes state
    saveTabSession();
    return true;
  }
  setTabGroup({ ...group, collapsed });
  commit();
  return true;
}

/** Dissolve (ungroup) a group: members stay open in place, the record goes. */
export function dissolveTabGroup(groupId: string): boolean {
  const group = getTabGroup(groupId);
  if (!group) return false;
  applyEntries(dissolveGroupEntries(scopedEntries(group.workspaceId), groupId));
  commit();
  return true;
}

/**
 * Close a group: closes every member tab (each close runs the normal teardown
 * + fallback-activation path); the empty group record is then pruned.
 */
export function closeTabGroup(groupId: string): boolean {
  const group = getTabGroup(groupId);
  if (!group) return false;
  const members = groupMemberIds(scopedEntries(group.workspaceId), groupId);
  for (const id of members) closeTab(id);
  pruneEmptyTabGroups();
  pushState();
  return true;
}

/**
 * Drag-reorder one tab to the slot of `targetId`, updating group membership
 * like Chrome: dropping strictly inside a group's span joins it; dragging a
 * member out of its span leaves it; group contiguity is re-normalized. Pinned
 * tabs keep the plain pinned-first reorder (they can't join groups).
 */
export function moveTabToTarget(tabId: string, targetId: string): boolean {
  const rec = getTab(tabId);
  const target = getTab(targetId);
  if (!rec || !target || tabId === targetId) return false;
  if (rec.workspaceId !== target.workspaceId) return false;
  const entries = scopedEntries(rec.workspaceId);
  let next = moveTabAmongGroups(entries, tabId, targetId);
  if (rec.pinned) {
    // A pinned tab never joins a group; pinnedFirst re-anchors it after.
    next = next.map((e) => (e.id === tabId ? { id: e.id, groupId: null } : e));
  }
  applyEntries(next);
  commit();
  return true;
}
