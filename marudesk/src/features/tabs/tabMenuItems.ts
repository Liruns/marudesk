import {
  Columns2,
  Copy,
  Group,
  Pin,
  PinOff,
  Plus,
  Ungroup,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { TabGroup, TabState } from '../../../shared/browser';
import { GROUP_COLOR_CLASSES } from './groupColors';

export type TabStripMenuLabels = {
  readonly close: string;
  readonly closeOthers: string;
  readonly closeRight: string;
  readonly duplicate: string;
  readonly exitSplit: string;
  readonly pin: string;
  readonly unpin: string;
  /** "Add to new group" (Chrome-style tab groups). */
  readonly addToNewGroup: string;
  /** Prefix for the flat "Add to group: <name>" entries. */
  readonly addToGroup: string;
  readonly removeFromGroup: string;
  readonly newTabInGroup: string;
  /** Display fallback for a group with an empty name. */
  readonly unnamedGroup: string;
};

export type TabMenuItem = {
  readonly key: string;
  readonly label: string;
  readonly icon?: LucideIcon;
  /** Colored dot glyph (tab-group hue) shown when there is no icon. */
  readonly dotClass?: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
};

type BuildTabMenuItemsInput = {
  readonly tab: TabState;
  readonly tabs: readonly TabState[];
  /** The tab is in a SPLIT-VIEW group (grid feature) — not a tab group. */
  readonly inGroup: boolean;
  /** Chrome-style tab groups in this workspace ("Add to group" targets). */
  readonly tabGroups: readonly TabGroup[];
  readonly labels: TabStripMenuLabels;
  readonly closeMany: (ids: readonly string[]) => void;
  readonly duplicate: () => void;
  readonly exitSplit: () => void;
  readonly togglePin: () => void;
  readonly addToNewTabGroup: () => void;
  readonly addToTabGroup: (groupId: string) => void;
  readonly removeFromTabGroup: () => void;
  readonly newTabInTabGroup: (groupId: string) => void;
};

export function buildTabMenuItems({
  tab,
  tabs,
  inGroup,
  tabGroups,
  labels,
  closeMany,
  duplicate,
  exitSplit,
  togglePin,
  addToNewTabGroup,
  addToTabGroup,
  removeFromTabGroup,
  newTabInTabGroup,
}: BuildTabMenuItemsInput): TabMenuItem[] {
  const idx = tabs.findIndex((t) => t.id === tab.id);
  const others = tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
  const toRight = tabs.slice(idx + 1).map((t) => t.id);
  const ownTabGroup = tabGroups.find((g) => g.id === tab.groupId);
  const otherTabGroups = tabGroups.filter((g) => g.id !== tab.groupId);
  // Pinned tabs can't be grouped (main refuses), so hide the group verbs.
  const groupItems: TabMenuItem[] = tab.pinned
    ? []
    : [
        {
          key: 'group-new',
          label: labels.addToNewGroup,
          icon: Group,
          onClick: addToNewTabGroup,
        },
        ...otherTabGroups.map(
          (group): TabMenuItem => ({
            key: `group-add-${group.id}`,
            label: `${labels.addToGroup} ${group.name.trim() || labels.unnamedGroup}`,
            dotClass: GROUP_COLOR_CLASSES[group.color].dot,
            onClick: () => addToTabGroup(group.id),
          }),
        ),
        ...(ownTabGroup
          ? [
              {
                key: 'group-remove',
                label: labels.removeFromGroup,
                icon: Ungroup,
                onClick: removeFromTabGroup,
              },
              // "New tab in group" only makes sense while the group is visible
              // (an expanded group); the new tab lands at the end of its span.
              ...(!ownTabGroup.collapsed
                ? [
                    {
                      key: 'group-new-tab',
                      label: labels.newTabInGroup,
                      icon: Plus,
                      onClick: () => newTabInTabGroup(ownTabGroup.id),
                    },
                  ]
                : []),
            ]
          : []),
      ];

  return [
    ...(!inGroup
      ? [
          {
            key: 'pin',
            label: tab.pinned ? labels.unpin : labels.pin,
            icon: tab.pinned ? PinOff : Pin,
            onClick: togglePin,
          },
        ]
      : []),
    ...groupItems,
    {
      key: 'close',
      label: labels.close,
      icon: X,
      onClick: () => closeMany([tab.id]),
    },
    {
      key: 'others',
      label: labels.closeOthers,
      disabled: others.length === 0,
      onClick: () => closeMany(others),
    },
    {
      key: 'right',
      label: labels.closeRight,
      disabled: toRight.length === 0,
      onClick: () => closeMany(toRight),
    },
    ...(tab.kind === 'web'
      ? [
          {
            key: 'dup',
            label: labels.duplicate,
            icon: Copy,
            onClick: duplicate,
          },
        ]
      : []),
    ...(inGroup
      ? [
          {
            key: 'exit',
            label: labels.exitSplit,
            icon: Columns2,
            onClick: exitSplit,
          },
        ]
      : []),
  ];
}
