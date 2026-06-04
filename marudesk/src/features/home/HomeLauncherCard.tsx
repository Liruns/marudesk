import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type HomeLauncherCardProps = {
  readonly label: string;
  readonly hint: string;
  readonly icon: ReactNode;
  readonly onOpen: () => void;
};

export function HomeLauncherCard({
  label,
  hint,
  icon,
  onOpen,
}: HomeLauncherCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex flex-col items-start gap-2.5 p-4 rounded-xl text-left',
        'bg-surface-1 bg-surface-gradient border border-subtle shadow-highlight',
        'hover:border-accent/60 hover:bg-surface-2 hover:-translate-y-0.5 hover:shadow-card',
        'active:translate-y-0 active:scale-[0.99] active:shadow-highlight',
        'transition duration-fast',
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-surface-2 shadow-highlight text-fg-secondary group-hover:bg-accent-subtle group-hover:text-accent transition-colors duration-fast">
        {icon}
      </span>
      <span className="text-body-sm text-fg-primary font-medium">{label}</span>
      <span className="text-caption text-fg-tertiary">{hint}</span>
    </button>
  );
}
