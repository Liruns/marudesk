import { Columns2, Copy, Pin, PinOff, X, type LucideIcon } from 'lucide-react';
import type { TabState } from '../../../shared/browser';

export type TabStripMenuLabels = {
  readonly close: string;
  readonly closeOthers: string;
  readonly closeRight: string;
  readonly duplicate: string;
  readonly exitSplit: string;
  readonly pin: string;
  readonly unpin: string;
};

export type TabMenuItem = {
  readonly key: string;
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly disabled?: boolean;
  readonly onClick: () => void;
};

type BuildTabMenuItemsInput = {
  readonly tab: TabState;
  readonly tabs: readonly TabState[];
  readonly inGroup: boolean;
  readonly labels: TabStripMenuLabels;
  readonly closeMany: (ids: readonly string[]) => void;
  readonly duplicate: () => void;
  readonly exitSplit: () => void;
  readonly togglePin: () => void;
};

export function buildTabMenuItems({
  tab,
  tabs,
  inGroup,
  labels,
  closeMany,
  duplicate,
  exitSplit,
  togglePin,
}: BuildTabMenuItemsInput): TabMenuItem[] {
  const idx = tabs.findIndex((t) => t.id === tab.id);
  const others = tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
  const toRight = tabs.slice(idx + 1).map((t) => t.id);

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
