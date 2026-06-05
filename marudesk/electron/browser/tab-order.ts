import { applyReorder } from '../../shared/browser';
import { getTab, pushState, reorderTabRecords, tabKeys } from './state';
import { savePinnedTabs } from './pinned-session';

/**
 * Tab ordering + pinning policy: keep pinned tabs anchored at the front of the
 * strip and rebuild the authoritative order. Split out of tabs.ts; no
 * WebContentsView wiring — operates on the tab-record state only.
 */

export function pinnedFirst(ids: string[]): string[] {
  return [
    ...ids.filter((id) => getTab(id)?.pinned),
    ...ids.filter((id) => !getTab(id)?.pinned),
  ];
}

export function reorderTabs(orderedIds: string[]): void {
  // Reorder via the shared policy (requested order, then any unlisted tabs
  // appended), then keep pinned tabs anchored at the front before rebuilding the
  // authoritative tab map — a drag can't drop an ordinary tab ahead of a pin.
  const order = pinnedFirst(applyReorder(tabKeys(), orderedIds));
  reorderTabRecords(order);
  pushState();
}

/**
 * Pin/unpin a tab. Pinned tabs render favicon-only and stay at the front of the
 * strip, so flipping the flag re-sorts pinned-first (Chrome/Edge "Pin tab").
 */
export function setTabPinned(id: string, pinned: boolean): boolean {
  const rec = getTab(id);
  if (!rec) return false;
  if (!!rec.pinned === pinned) return true;
  rec.pinned = pinned;
  reorderTabRecords(pinnedFirst(tabKeys()));
  pushState();
  savePinnedTabs();
  return true;
}
