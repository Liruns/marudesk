import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Badge color variants. Exported so status maps can stay in lockstep with this list. */
export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

export type BadgeProps = {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
};

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-3 text-fg-secondary',
  accent: 'bg-accent-subtle text-accent',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  error: 'bg-error-subtle text-error',
};

export function Badge({ variant = 'neutral', children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        // shrink-0 + nowrap: a status badge must never wrap or get squeezed in a
        // tight flex row (e.g. the provider card header). Crisp/dense language:
        // a small-radius rectangle, not a full pill, packed tight.
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-sm px-1.5 py-0 text-caption font-medium tabular-nums',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
