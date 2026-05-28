import { useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Anchor = 'right' | 'bottom';

export type DrawerProps = {
  open: boolean;
  anchor?: Anchor;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  className?: string;
  width?: number;
  height?: number;
  ariaLabel?: string;
};

export function Drawer({
  open,
  anchor = 'right',
  onOpenChange,
  children,
  className,
  width = 380,
  height = 360,
  ariaLabel,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange?.(false);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [open, onOpenChange]);

  const isRight = anchor === 'right';
  const closedTransform = isRight ? 'translate-x-full' : 'translate-y-full';

  return (
    <aside
      role="dialog"
      aria-label={ariaLabel}
      aria-hidden={!open}
      className={cn(
        'fixed z-40 bg-surface-1 shadow-glow',
        isRight
          ? 'top-0 right-0 h-full border-l border-subtle'
          : 'bottom-0 left-0 right-0 border-t border-subtle',
        'transition-transform duration-standard',
        open ? 'translate-x-0 translate-y-0' : closedTransform,
        className,
      )}
      style={{
        width: isRight ? `${width}px` : undefined,
        height: !isRight ? `${height}px` : undefined,
      }}
    >
      {children}
    </aside>
  );
}
