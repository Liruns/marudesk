import { TAB_GROUP_COLORS, type TabGroupColor } from './browser';

/**
 * Pure tab-group math: contiguity, membership and reorder policy, shared by
 * the authoritative main-process verbs (electron/browser/tab-groups.ts) and
 * unit-tested in isolation (./tab-groups.test.ts). No Electron imports — these
 * operate on plain `{ id, groupId }` entries so main, renderer, and tests all
 * agree on what a drag/collapse/dissolve does to the strip.
 *
 * Invariant the helpers maintain (and main enforces after every mutation):
 * the members of one group form a contiguous run in the tab order.
 */

export type GroupEntry = {
  readonly id: string;
  readonly groupId: string | null;
};

/** The member tab ids of `groupId`, in entry order (close-group closes these). */
export function groupMemberIds(
  entries: readonly GroupEntry[],
  groupId: string,
): string[] {
  return entries.filter((e) => e.groupId === groupId).map((e) => e.id);
}

/**
 * The contiguous span of `groupId` as [start, end) indices, or null when the
 * group has no members. Assumes entries are already contiguity-normalized.
 */
export function groupSpan(
  entries: readonly GroupEntry[],
  groupId: string,
): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]?.groupId === groupId) {
      if (start < 0) start = i;
      end = i + 1;
    }
  }
  return start < 0 ? null : { start, end };
}

/**
 * Re-establish group contiguity without changing membership: each group's
 * members are pulled together (keeping their relative order) at the position of
 * the group's first member; ungrouped entries keep their relative order. A
 * no-op on an already-contiguous list.
 */
export function normalizeGroupContiguity(
  entries: readonly GroupEntry[],
): GroupEntry[] {
  const emitted = new Set<string>();
  const out: GroupEntry[] = [];
  for (const entry of entries) {
    if (emitted.has(entry.id)) continue;
    if (entry.groupId === null) {
      out.push(entry);
      emitted.add(entry.id);
      continue;
    }
    for (const member of entries) {
      if (member.groupId === entry.groupId && !emitted.has(member.id)) {
        out.push(member);
        emitted.add(member.id);
      }
    }
  }
  return out;
}

/**
 * Move `tabId` to the slot currently occupied by `targetId` (the drag-reorder
 * gesture: remove, then insert at the target's original index — landing after
 * the target when dragging rightward, before it when dragging leftward), then
 * update group membership the way Chrome does:
 *
 * - dropped strictly INSIDE another group's span (both new neighbors share a
 *   group) → the tab joins that group;
 * - dropped touching its own group (a neighbor is still a co-member) → it
 *   keeps its membership;
 * - dropped anywhere else (including the edge of a foreign group) → ungrouped.
 *
 * Returns a contiguity-normalized list; unchanged input when either id is
 * missing or the move is a no-op. Entries should be one workspace's tabs.
 */
export function moveTabAmongGroups(
  entries: readonly GroupEntry[],
  tabId: string,
  targetId: string,
): GroupEntry[] {
  const from = entries.findIndex((e) => e.id === tabId);
  const to = entries.findIndex((e) => e.id === targetId);
  if (from < 0 || to < 0 || from === to) return [...entries];
  const moved = entries[from];
  if (!moved) return [...entries];
  const next = [...entries];
  next.splice(from, 1);
  next.splice(to, 0, moved);
  const at = to;
  const left = at > 0 ? next[at - 1] : undefined;
  const right = at + 1 < next.length ? next[at + 1] : undefined;
  let groupId: string | null = null;
  if (left?.groupId && left.groupId === right?.groupId) {
    // Strictly inside a group's span — join it (also covers staying inside
    // the tab's own group).
    groupId = left.groupId;
  } else if (
    moved.groupId !== null &&
    (left?.groupId === moved.groupId || right?.groupId === moved.groupId)
  ) {
    // Still touching its own group — keep membership (drag within the span,
    // or to either end of it).
    groupId = moved.groupId;
  }
  next[at] = { id: moved.id, groupId };
  return normalizeGroupContiguity(next);
}

/** Set `tabId`'s membership to `groupId` in place (create-group-from-tab). */
export function assignGroup(
  entries: readonly GroupEntry[],
  tabId: string,
  groupId: string,
): GroupEntry[] {
  return normalizeGroupContiguity(
    entries.map((e) => (e.id === tabId ? { id: e.id, groupId } : e)),
  );
}

/**
 * Add `tabId` to `groupId`, moving it to the end of the group's span ("Add to
 * group" menu action). When the group currently has no members the tab keeps
 * its slot and simply becomes the first member.
 */
export function addTabToGroupEntries(
  entries: readonly GroupEntry[],
  tabId: string,
  groupId: string,
): GroupEntry[] {
  const idx = entries.findIndex((e) => e.id === tabId);
  if (idx < 0) return [...entries];
  const without = entries.filter((e) => e.id !== tabId);
  const span = groupSpan(without, groupId);
  const insertAt = span ? span.end : idx;
  const next = [...without];
  next.splice(insertAt, 0, { id: tabId, groupId });
  return normalizeGroupContiguity(next);
}

/**
 * Remove `tabId` from its group ("Remove from group"): membership cleared and
 * the tab re-slotted just AFTER the group's remaining span so a mid-group
 * removal can't split the run. Unchanged when the tab is ungrouped.
 */
export function removeTabFromGroupEntries(
  entries: readonly GroupEntry[],
  tabId: string,
): GroupEntry[] {
  const entry = entries.find((e) => e.id === tabId);
  if (!entry || entry.groupId === null) return [...entries];
  const without = entries.filter((e) => e.id !== tabId);
  const span = groupSpan(without, entry.groupId);
  const insertAt = span ? span.end : entries.indexOf(entry);
  const next = [...without];
  next.splice(insertAt, 0, { id: tabId, groupId: null });
  return normalizeGroupContiguity(next);
}

/** Dissolve (ungroup) `groupId`: every member's membership cleared, order kept. */
export function dissolveGroupEntries(
  entries: readonly GroupEntry[],
  groupId: string,
): GroupEntry[] {
  return entries.map((e) =>
    e.groupId === groupId ? { id: e.id, groupId: null } : e,
  );
}

/**
 * The tab ids hidden from the strip because their group is collapsed. The tabs
 * stay in the registry — Ctrl+Tab / the tab list can still reach them (which
 * expands the group).
 */
export function hiddenTabIds(
  entries: readonly GroupEntry[],
  isCollapsed: (groupId: string) => boolean,
): Set<string> {
  const hidden = new Set<string>();
  for (const e of entries) {
    if (e.groupId !== null && isCollapsed(e.groupId)) hidden.add(e.id);
  }
  return hidden;
}

/**
 * The tab to activate when `groupId` collapses while holding the active tab:
 * the nearest entry outside the group that `isEligible` accepts — scanning
 * right from the span first, then left (Chrome's nearest-visible policy).
 * Null when nothing qualifies (the caller should then refuse the collapse).
 */
export function nearestOutsideGroup(
  entries: readonly GroupEntry[],
  groupId: string,
  isEligible: (id: string) => boolean,
): string | null {
  const span = groupSpan(entries, groupId);
  if (!span) return null;
  for (let i = span.end; i < entries.length; i++) {
    const e = entries[i];
    if (e && e.groupId !== groupId && isEligible(e.id)) return e.id;
  }
  for (let i = span.start - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.groupId !== groupId && isEligible(e.id)) return e.id;
  }
  return null;
}

/**
 * Merge a reordered workspace-scoped subsequence back into the full tab order:
 * the positions the scoped ids occupy in `fullOrder` are refilled, in place,
 * with `scopedOrder`'s sequence. Ids in `scopedOrder` that are not in
 * `fullOrder` are ignored; scoped positions beyond the new sequence collapse.
 */
export function applyScopedOrder(
  fullOrder: readonly string[],
  scopedOrder: readonly string[],
): string[] {
  const scoped = new Set(scopedOrder);
  const replacements = scopedOrder.filter((id) => fullOrder.includes(id));
  let next = 0;
  const out: string[] = [];
  for (const id of fullOrder) {
    if (scoped.has(id)) {
      const replacement = replacements[next++];
      if (replacement !== undefined) out.push(replacement);
    } else {
      out.push(id);
    }
  }
  return out;
}

/**
 * Pick the color for a new group: the first palette hue not in use in this
 * workspace, falling back to cycling by group count when all are taken —
 * Chrome's "each new group gets the next color" feel without repeats until
 * the palette is exhausted.
 */
export function nextGroupColor(
  usedColors: readonly TabGroupColor[],
): TabGroupColor {
  const free = TAB_GROUP_COLORS.find((c) => !usedColors.includes(c));
  if (free) return free;
  const fallback = TAB_GROUP_COLORS[usedColors.length % TAB_GROUP_COLORS.length];
  return fallback ?? TAB_GROUP_COLORS[0];
}
