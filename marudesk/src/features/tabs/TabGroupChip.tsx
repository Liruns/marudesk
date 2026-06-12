import { useEffect, useRef } from 'react';
import type { TabGroup } from '../../../shared/browser';
import { cn } from '../../lib/cn';
import { GROUP_COLOR_CLASSES } from './groupColors';

export type TabGroupChipLabels = {
  /** Accessible prefix for the chip ("Tab group"). */
  readonly tabGroup: string;
  /** Display fallback for a group with an empty name. */
  readonly unnamed: string;
  /** Placeholder for the inline rename input. */
  readonly renamePlaceholder: string;
};

type TabGroupChipProps = {
  readonly group: TabGroup;
  /** Member tab count — shown on the chip while the group is collapsed. */
  readonly memberCount: number;
  /** When true the chip swaps to an inline rename input (Enter/Escape). */
  readonly renaming: boolean;
  readonly labels: TabGroupChipLabels;
  readonly onToggleCollapse: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onRenameCommit: (name: string) => void;
  readonly onRenameCancel: () => void;
};

/**
 * The colored header chip of a Chrome-style tab group, rendered in the strip
 * before the group's first member tab. Clicking it collapses/expands the group
 * (main owns the state); while collapsed it shows the hidden-tab count. NOT a
 * `role="tab"` element — e2e specs count tabs by role, and the chip is a group
 * header, not a tab.
 */
export function TabGroupChip({
  group,
  memberCount,
  renaming,
  labels,
  onToggleCollapse,
  onContextMenu,
  onRenameCommit,
  onRenameCancel,
}: TabGroupChipProps) {
  const colors = GROUP_COLOR_CLASSES[group.color];
  const displayName = group.name.trim() || labels.unnamed;
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape blurs the input; the flag keeps that blur from also committing.
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!renaming) return;
    cancelledRef.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  if (renaming) {
    return (
      <span
        className={cn(
          'flex items-center h-6 shrink-0 rounded-pill px-2 no-drag',
          colors.chip,
        )}
      >
        <input
          ref={inputRef}
          type="text"
          defaultValue={group.name}
          placeholder={labels.renamePlaceholder}
          aria-label={`${labels.tabGroup}: ${displayName}`}
          className={cn(
            'w-[110px] bg-transparent text-caption font-medium outline-none',
            'placeholder:text-fg-tertiary text-fg-primary',
          )}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onRenameCommit(e.currentTarget.value.trim());
            } else if (e.key === 'Escape') {
              cancelledRef.current = true;
              onRenameCancel();
            }
            e.stopPropagation();
          }}
          onBlur={(e) => {
            if (cancelledRef.current) return;
            onRenameCommit(e.currentTarget.value.trim());
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={`${labels.tabGroup}: ${displayName}`}
      aria-expanded={!group.collapsed}
      title={
        group.collapsed ? `${displayName} (${memberCount})` : displayName
      }
      onClick={onToggleCollapse}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      className={cn(
        'flex items-center gap-1.5 h-6 shrink-0 rounded-pill px-2.5 no-drag',
        'text-caption font-medium select-none transition-colors duration-fast',
        'hover:brightness-110',
        colors.chip,
      )}
    >
      {group.name.trim() ? (
        <span className="max-w-[140px] truncate">{group.name}</span>
      ) : (
        <span aria-hidden className={cn('size-2 rounded-pill', colors.dot)} />
      )}
      {group.collapsed ? (
        <span className="tabular-nums">({memberCount})</span>
      ) : null}
    </button>
  );
}
