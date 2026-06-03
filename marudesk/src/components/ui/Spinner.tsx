import { cn } from '../../lib/cn';

export type SpinnerProps = {
  size?: number;
  className?: string;
  label?: string;
};

export function Spinner({ size = 16, className, label = 'Working' }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn('motion-safe:animate-spin-ai shrink-0', className)}
      role="status"
      aria-label={label}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        strokeWidth="3"
        stroke="var(--border-default)"
      />
      <path
        d="M12 3 A9 9 0 0 1 21 12"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        stroke="var(--ai-thinking)"
      />
      <path
        d="M21 12 A9 9 0 0 1 12 21"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        stroke="var(--ai-grep)"
      />
      <path
        d="M12 21 A9 9 0 0 1 3 12"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        stroke="var(--ai-read)"
      />
      <path
        d="M3 12 A9 9 0 0 1 12 3"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        stroke="var(--ai-edit)"
      />
    </svg>
  );
}
