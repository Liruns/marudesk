import type { TabMenuItem } from './tabMenuItems';
import { cn } from '../../lib/cn';

type TabStripMenuProps = {
  readonly x: number;
  readonly y: number;
  readonly items: readonly TabMenuItem[];
  readonly onClose: () => void;
};

export function TabStripMenu({
  x,
  y,
  items,
  onClose,
}: TabStripMenuProps) {
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
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                if (it.disabled) return;
                it.onClick();
                onClose();
              }}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 text-left text-caption',
                'transition-colors duration-fast',
                it.disabled
                  ? 'text-fg-tertiary/50 cursor-default'
                  : 'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
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
