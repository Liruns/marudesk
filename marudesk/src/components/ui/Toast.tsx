import { X } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';

type Variant = 'neutral' | 'success' | 'warning' | 'error';

export type ToastProps = {
  title: string;
  description?: string;
  variant?: Variant;
  onDismiss?: () => void;
  className?: string;
};

const DOT_CLASSES: Record<Variant, string> = {
  neutral: 'bg-fg-tertiary',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
};

export function Toast({
  title,
  description,
  variant = 'neutral',
  onDismiss,
  className,
}: ToastProps) {
  const { t } = useI18n();
  // Failures interrupt (assertive); success/info stay polite so they don't
  // talk over the user mid-task.
  const isError = variant === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={cn(
        'flex items-start gap-2.5 bg-surface-2 border border-default rounded shadow-glow',
        'w-[340px] max-w-[90vw] px-3 py-2.5',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('mt-1.5 size-2 rounded-pill shrink-0', DOT_CLASSES[variant])}
      />
      <div className="flex-1 min-w-0">
        <div className="text-body-sm font-medium text-fg-primary">{title}</div>
        {description ? (
          <div className="text-caption text-fg-secondary mt-0.5">{description}</div>
        ) : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('agent.chat.dismiss')}
          className="-mr-1 -mt-1 flex size-5 shrink-0 items-center justify-center rounded text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary transition-colors duration-fast"
        >
          <X size={13} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
