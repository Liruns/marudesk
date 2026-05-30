import { cn } from '../../lib/cn';

/**
 * The shared panel-tab button, used by BOTH the in-page dock (DevtoolsDock) and
 * the pop-out window (DevtoolsWindow). The panel registry lives in
 * `panel-list.ts` (data-only).
 */
export function PanelTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'h-7 px-2.5 rounded text-body-sm transition-colors duration-fast',
        active
          ? 'bg-surface-page text-fg-primary'
          : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
      )}
    >
      {label}
    </button>
  );
}
