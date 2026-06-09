import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function NavItem({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'chrome-list-row h-8 px-2.5 gap-2 text-body-sm text-left',
        active
          ? 'bg-accent-subtle text-fg-primary shadow-highlight hover:bg-accent-subtle'
          : 'text-fg-secondary',
      )}
    >
      <span className={active ? 'text-accent' : 'text-fg-tertiary'} aria-hidden>
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

export function Section({ children }: { children: ReactNode }) {
  return (
    <div className="chrome-panel flex flex-col rounded-lg overflow-hidden divide-y divide-subtle">
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-body-sm text-fg-primary">{label}</span>
        {hint ? (
          <span className="text-caption text-fg-tertiary">{hint}</span>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
