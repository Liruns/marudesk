import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    'bg-accent text-white shadow-card hover:bg-accent-hover active:shadow-none',
  secondary:
    'bg-surface-2 text-fg-primary border border-default shadow-highlight hover:bg-surface-3 hover:border-strong/50',
  ghost:
    'bg-transparent text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
};

// Dense/crisp: one step tighter than comfortable so toolbars and card footers
// pack more controls per row without crowding the label.
const SIZE_CLASSES: Record<Size, string> = {
  sm: 'h-6 px-2.5 text-body-sm',
  md: 'h-7 px-3 text-body-sm',
  lg: 'h-8 px-3.5 text-body',
};

export function Button({
  variant = 'primary',
  size = 'md',
  leadingIcon,
  trailingIcon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded font-medium',
        // Press feedback is a 1px settle, never a bounce (DESIGN.md §9).
        'transition duration-fast active:scale-[0.99]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-inherit',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {leadingIcon ? <span className="inline-flex shrink-0">{leadingIcon}</span> : null}
      {children}
      {trailingIcon ? <span className="inline-flex shrink-0">{trailingIcon}</span> : null}
    </button>
  );
}
