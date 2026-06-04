import type { ReactNode } from 'react';
import { Columns2 } from 'lucide-react';
import { cn } from '../../lib/cn';

export type SplitGroupLabels = {
  readonly group: string;
  readonly exit: string;
};

type SplitGroupProps = {
  readonly children: ReactNode;
  readonly labels: SplitGroupLabels;
  readonly onExit: () => void;
};

export function SplitGroup({ children, labels, onExit }: SplitGroupProps) {
  return (
    <div
      role="group"
      aria-label={labels.group}
      className={cn(
        'group/split relative flex items-center gap-0.5 h-8 px-1 rounded-lg shrink-0',
        'bg-surface-2/60 ring-1 ring-inset ring-accent/25 no-drag',
      )}
    >
      <button
        type="button"
        onClick={onExit}
        aria-label={labels.exit}
        title={labels.exit}
        className={cn(
          'size-5 rounded flex items-center justify-center shrink-0',
          'text-accent/70 hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
        )}
      >
        <Columns2 size={12} />
      </button>
      {children}
    </div>
  );
}
