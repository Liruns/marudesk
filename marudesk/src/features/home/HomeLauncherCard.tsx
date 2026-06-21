import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type HomeLauncherCardProps = {
  readonly label: string;
  readonly hint: string;
  readonly icon: ReactNode;
  readonly onOpen: () => void;
  /** Extra grid-placement classes (e.g. an odd last card spanning both columns). */
  readonly className?: string;
};

export function HomeLauncherCard({
  label,
  hint,
  icon,
  onOpen,
  className,
}: HomeLauncherCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'chrome-panel group flex flex-col items-start gap-2.5 p-3 rounded-lg text-left',
        'hover:border-accent/60 hover:bg-surface-2 hover:-translate-y-0.5 hover:shadow-card',
        'active:translate-y-0 active:scale-[0.99] active:shadow-highlight',
        'transition duration-fast',
        className,
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-surface-2 shadow-highlight text-fg-secondary group-hover:bg-accent-subtle group-hover:text-accent transition-colors duration-fast">
        {icon}
      </span>
      <span className="text-body-sm text-fg-primary font-medium">{label}</span>
      {/* Hint visibility tracks the grid's own container (@lg → the 2-column
          threshold), not the window: keying it to the viewport `xl` breakpoint
          dropped the hint whenever the stage was wide but the window wasn't
          (e.g. 1024px) and kept it when a drawer squeezed the stage narrow. */}
      <span className="hidden @lg:block text-caption text-fg-tertiary">{hint}</span>
    </button>
  );
}
