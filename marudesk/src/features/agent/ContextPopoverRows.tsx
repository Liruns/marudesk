import { Plus } from 'lucide-react';
import { cn } from '../../lib/cn';

export function ContextSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="px-3 pt-2 pb-1 text-caption uppercase tracking-wider text-fg-tertiary">
        {label}
      </div>
      <div className="flex flex-col pb-1 max-h-40 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

export function CaptureRow({
  icon,
  kind,
  label,
  selected,
  onToggle,
}: {
  icon: React.ReactNode;
  kind: string;
  label: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'w-full flex items-center gap-2 px-3 h-7 text-left',
        'transition-colors duration-fast',
        'hover:bg-surface-2 focus:bg-surface-2 outline-none',
        selected ? 'text-fg-primary' : 'text-fg-secondary',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 rounded border flex items-center justify-center',
          selected
            ? 'bg-accent border-accent text-white'
            : 'border-default bg-surface-page',
        )}
      >
        {selected ? (
          <svg
            viewBox="0 0 10 8"
            width={8}
            height={8}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              d="M1 4l3 3 5-5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
      <span className="shrink-0 text-fg-tertiary">{icon}</span>
      <span className="text-caption text-fg-tertiary shrink-0 w-10 truncate">
        {kind}
      </span>
      <span className="flex-1 min-w-0 truncate text-caption">{label}</span>
    </button>
  );
}

export function TabRow({
  icon,
  kind,
  label,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  kind: string;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'w-full flex items-center gap-2 px-3 h-7 text-left',
        'transition-colors duration-fast',
        'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
        'focus:bg-surface-2 focus:text-fg-primary outline-none',
      )}
    >
      <span className="shrink-0 text-fg-tertiary">{icon}</span>
      <span className="text-caption text-fg-tertiary shrink-0 w-10 truncate">
        {kind}
      </span>
      <span className="flex-1 min-w-0 truncate text-caption">{label}</span>
      <Plus size={10} className="shrink-0 text-fg-tertiary/60" />
    </button>
  );
}
