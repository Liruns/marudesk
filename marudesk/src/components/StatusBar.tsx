import { useWebPageStore } from '../features/browser/store';
import { useComposerStore } from '../features/composer/store';
import { useProvidersStore } from '../features/providers/store';
import { useWorkspaceStore } from '../features/workspace/store';
import { getProvider } from '../../shared/providers';

/**
 * VSCode-style status strip pinned to the bottom of the window. Surfaces the
 * always-relevant facts that used to live in the header (workspace name, file
 * count) plus runtime status (inspect on, propose in flight, active model).
 *
 * Kept thin (24px) so it costs almost nothing vertically — the browser stage
 * is the canvas, this is just chrome.
 */
export function StatusBar() {
  const summary = useWorkspaceStore((s) => s.summary);
  const inspectMode = useWebPageStore((s) => s.inspectMode);
  const captures = useWebPageStore((s) => s.captures);
  const selectedProvider = useProvidersStore((s) => s.selectedProvider);
  const selectedModel = useProvidersStore((s) => s.selectedModel);
  const proposing = useComposerStore((s) => s.proposing);
  const providerStatus = useProvidersStore((s) => s.providerStatus);

  const hasKey = providerStatus.find((p) => p.id === selectedProvider)?.hasKey;

  return (
    <footer
      role="contentinfo"
      className="h-6 shrink-0 flex items-center gap-3 px-3 text-caption tabular-nums bg-surface-1 border-t border-subtle text-fg-tertiary select-none"
    >
      <span className="flex items-center gap-1.5 min-w-0">
        {summary ? (
          <>
            <span
              aria-hidden
              className="size-1.5 rounded-pill bg-accent shrink-0"
            />
            <span
              className="truncate text-fg-secondary max-w-[200px]"
              title={summary.root}
            >
              {summary.name}
            </span>
            <span>
              {summary.files.length}
              {summary.truncated ? '+' : ''} files
            </span>
          </>
        ) : (
          <>
            <span
              aria-hidden
              className="size-1.5 rounded-pill bg-fg-tertiary/40 shrink-0"
            />
            <span>No workspace</span>
          </>
        )}
      </span>
      <span className="flex-1" aria-hidden />
      {inspectMode ? <span className="text-accent">Inspect on</span> : null}
      {captures.length > 0 ? (
        <span>
          {captures.length} capture{captures.length === 1 ? '' : 's'}
        </span>
      ) : null}
      {proposing ? <span className="text-accent">Proposing patch…</span> : null}
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={
            hasKey
              ? 'size-1.5 rounded-pill bg-accent shrink-0'
              : 'size-1.5 rounded-pill bg-fg-tertiary/40 shrink-0'
          }
        />
        <span className="truncate max-w-[280px]">
          {getProvider(selectedProvider).label} · {selectedModel}
        </span>
      </span>
    </footer>
  );
}
