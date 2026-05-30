import { lazy, Suspense } from 'react';
import { Spinner } from '../../components/ui';

// xterm + the PTY bridge load on first terminal open, not at app start (mirrors
// Monaco). This is the single lazy import for the terminal view — Stage and
// GridStage used to each carry their own copy, which was a standing drift
// hazard. Pre-bundled in vite.config optimizeDeps so the first open doesn't
// trigger a dev re-optimize.
const TerminalView = lazy(() =>
  import('../terminal/TerminalView').then((m) => ({ default: m.TerminalView })),
);

/**
 * The lazy terminal surface wrapped in its own Suspense boundary, so both
 * dispatch sites (the single view via `Stage` and a grid pane via `GridStage`)
 * get the same spinner fallback without re-declaring lazy/Suspense. Lives in its
 * own file so the `tabKinds` registry stays a pure data module (Fast Refresh
 * wants a component file to export only components).
 */
export function TerminalSurface({ tabId }: { tabId?: string }) {
  return (
    <Suspense
      fallback={
        <div className="flex-1 min-w-0 min-h-0 flex items-center justify-center bg-surface-page">
          <Spinner size={18} />
        </div>
      }
    >
      <TerminalView tabId={tabId} />
    </Suspense>
  );
}
