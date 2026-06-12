import { applyReorder } from '../../shared/browser';
import { normalizeGroupContiguity } from '../../shared/tab-groups';
import {
  getTab,
  pruneEmptyTabGroups,
  pushState,
  reorderTabRecords,
  tabKeys,
} from './state';
import { savePinnedTabs } from './pinned-session';
import { saveTabSession } from './tab-session';

/**
 * Tab ordering + pinning policy: keep pinned tabs anchored at the front of the
 * strip, keep each tab group's members a contiguous run, and rebuild the
 * authoritative order. Split out of tabs.ts; no WebContentsView wiring —
 * operates on the tab-record state only.
 */

export function pinnedFirst(ids: string[]): string[] {
  return [
    ...ids.filter((id) => getTab(id)?.pinned),
    ...ids.filter((id) => !getTab(id)?.pinned),
  ];
}

/**
 * Re-establish tab-group contiguity over the full order without changing any
 * membership: each group's members are pulled together at the group's first
 * member. Safe to run after any raw id reorder (the membership-aware drag path
 * lives in ./tab-groups `moveTabToTarget`).
 */
export function groupContiguousOrder(ids: string[]): string[] {
  return normalizeGroupContiguity(
    ids.map((id) => ({ id, groupId: getTab(id)?.groupId ?? null })),
  ).map((entry) => entry.id);
}

export function reorderTabs(orderedIds: string[]): void {
  // Reorder via the shared policy (requested order, then any unlisted tabs
  // appended), then keep pinned tabs anchored at the front and group members
  // contiguous before rebuilding the authoritative tab map — a drag can't drop
  // an ordinary tab ahead of a pin or split a tab group's run.
  const order = groupContiguousOrder(pinnedFirst(applyReorder(tabKeys(), orderedIds)));
  reorderTabRecords(order);
  pushState();
}

/**
 * Pin/unpin a tab. Pinned tabs render favicon-only and stay at the front of the
 * strip, so flipping the flag re-sorts pinned-first (Chrome/Edge "Pin tab").
 * Pinning a grouped tab removes it from its group first — pins and groups are
 * mutually exclusive, as in Chrome.
 */
export function setTabPinned(id: string, pinned: boolean): boolean {
  const rec = getTab(id);
  if (!rec) return false;
  if (!!rec.pinned === pinned) return true;
  rec.pinned = pinned;
  if (pinned && rec.groupId) {
    rec.groupId = undefined;
    pruneEmptyTabGroups();
  }
  reorderTabRecords(groupContiguousOrder(pinnedFirst(tabKeys())));
  pushState();
  savePinnedTabs();
  saveTabSession();
  return true;
}
