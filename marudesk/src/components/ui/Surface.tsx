import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'panel' | 'card' | 'inset';

export type SurfaceProps = HTMLAttributes<HTMLDivElement> & {
  variant?: Variant;
  children?: ReactNode;
};

// Each variant pairs its surface fill with the matching depth cue (§6): a panel
// sits flush and only catches light on its top edge; a card lifts off the page
// with a top→bottom gradient + soft drop; an inset reads as carved in via a
// gentle inner shadow. The hairline border still leads in every case.
const VARIANT_CLASSES: Record<Variant, string> = {
  panel: 'bg-surface-1 border border-subtle shadow-highlight',
  card: 'bg-surface-2 bg-surface-gradient border border-subtle shadow-card',
  inset: 'bg-surface-3 border border-subtle shadow-inset-soft',
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
