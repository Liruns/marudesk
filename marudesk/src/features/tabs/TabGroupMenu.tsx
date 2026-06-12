import type { LucideIcon } from 'lucide-react';
import {
  TAB_GROUP_COLORS,
  type TabGroupColor,
} from '../../../shared/browser';
import { cn } from '../../lib/cn';
import { GROUP_COLOR_CLASSES } from './groupColors';

export type TabGroupMenuItem = {
  readonly key: string;
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly onClick: () => void;
};

type TabGroupMenuProps = {
  readonly x: number;
  readonly y: number;
  /** The group's current color — its swatch renders a selected ring. */
  readonly color: TabGroupColor;
  /** Accessible name of the swatch row ("Group color"). */
  readonly colorRowLabel: string;
  /** Accessible name per palette hue, e.g. { violet: 'Violet', … }. */
  readonly colorLabels: Readonly<Record<TabGroupColor, string>>;
  readonly items: readonly TabGroupMenuItem[];
  readonly onPickColor: (color: TabGroupColor) => void;
  readonly onClose: () => void;
};

/**
 * Right-click menu of a tab-group chip: a color-swatch row (the `--tabgroup-*`
 * palette) above the action items. Same overlay/panel pattern as TabStripMenu;
 * separate component because swatches don't fit the icon+label item shape.
 */
export function TabGroupMenu({
  x,
  y,
  color,
  colorRowLabel,
  colorLabels,
  items,
  onPickColor,
  onClose,
}: TabGroupMenuProps) {
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
          'border border-subtle bg-surface-2 shadow-glow',
        )}
        style={{ top: y, left: x }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          role="group"
          aria-label={colorRowLabel}
          className="flex items-center gap-1.5 px-3 py-2"
        >
          {TAB_GROUP_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="menuitemradio"
              aria-checked={c === color}
              aria-label={colorLabels[c]}
              title={colorLabels[c]}
              onClick={() => {
                onPickColor(c);
                onClose();
              }}
              className={cn(
                'size-4 rounded-pill transition-transform duration-fast',
                'hover:scale-110',
                GROUP_COLOR_CLASSES[c].swatch,
                c === color
                  ? 'ring-2 ring-fg-primary/70 ring-offset-1 ring-offset-surface-2'
                  : '',
              )}
            />
          ))}
        </div>
        <div className="h-px mx-2 my-0.5 bg-border-subtle" aria-hidden />
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => {
                it.onClick();
                onClose();
              }}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-left text-caption',
                'transition-colors duration-fast',
                'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
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
