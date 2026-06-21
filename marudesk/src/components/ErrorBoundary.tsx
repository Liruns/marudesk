import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TriangleAlert, RotateCw } from 'lucide-react';
import { Button } from './ui/Button';
import { useI18n } from '../i18n/useI18n';

type ErrorBoundaryProps = {
  readonly children: ReactNode;
  /** Optional context label, logged alongside the caught error. */
  readonly label?: string;
  /** Optional custom fallback; receives the caught error. */
  readonly fallback?: (error: Error) => ReactNode;
};

type ErrorBoundaryState = {
  readonly error: Error | null;
};

/**
 * Default fallback card shown when a wrapped surface throws during render.
 * A function component so it can localize via `useI18n` (the boundary class
 * stays hook-free). Token colours only — see DESIGN.md.
 */
function ErrorBoundaryFallback() {
  const { t } = useI18n();
  return (
    <div className="size-full flex flex-col items-center justify-center gap-4 text-center px-8 bg-surface-page">
      <span className="size-12 rounded-full bg-surface-2 text-warning flex items-center justify-center">
        <TriangleAlert size={24} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-title text-fg-primary">{t('errorBoundary.title')}</h2>
        <p className="text-body-sm text-fg-tertiary max-w-md">
          {t('errorBoundary.body')}
        </p>
      </div>
      <Button
        variant="secondary"
        leadingIcon={<RotateCw size={15} />}
        onClick={() => location.reload()}
      >
        {t('errorBoundary.reload')}
      </Button>
    </div>
  );
}

/**
 * Catches uncaught render errors in a subtree so one broken surface degrades
 * locally to a recoverable fallback card instead of unmounting the whole app
 * (which would blank the Electron window with no way back). Wrap the major
 * Shell surfaces individually; main.tsx wraps <App/> as the last-resort net.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`,
      error,
      info.componentStack,
    );
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error !== null) {
      if (this.props.fallback) return this.props.fallback(error);
      return <ErrorBoundaryFallback />;
    }
    return this.props.children;
  }
}
