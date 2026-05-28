import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'panel' | 'card' | 'inset';

export type SurfaceProps = HTMLAttributes<HTMLDivElement> & {
  variant?: Variant;
  children?: ReactNode;
};

const VARIANT_CLASSES: Record<Variant, string> = {
  panel: 'bg-surface-1 border border-subtle',
  card: 'bg-surface-2 border border-subtle',
  inset: 'bg-surface-3 border border-subtle',
};

export function Surface({
  variant = 'panel',
  className,
  children,
  ...rest
}: SurfaceProps) {
  return (
    <div className={cn(VARIANT_CLASSES[variant], 'rounded', className)} {...rest}>
      {children}
    </div>
  );
}
