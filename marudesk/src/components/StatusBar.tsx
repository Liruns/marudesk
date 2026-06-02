import { GitBranch } from 'lucide-react';
import { useWebPageStore } from '../features/browser/store';
import { useProvidersStore } from '../features/providers/store';
import { useWorkspaceStore } from '../features/workspace/store';
import { useGitStore } from '../features/git/store';
import { providerLabel } from '../../shared/providers';

/**
 * VSCode-style status strip pinned to the bottom of the window. Surfaces the
 * always-relevant facts that used to live in the header (workspace name, file
 * count) plus runtime status (inspect on, active model).
 *
 * Kept thin (24px) so it costs almost nothing vertically — the browser stage
 * is the canvas, this is just chrome.
 */
export function StatusBar() {
  const summary = useWorkspaceStore((s) => s.summary);
  const gitStatus = useGitStore((s) => s.status);
  const inspectMode = useWebPageStore((s) => s.inspectMode);
  const captures = useWebPageStore((s) => s.captures);
  const selectedProvider = useProvidersStore((s) => s.selectedProvider);
  const selectedModel = useProvidersStore((s) => s.selectedModel);
  const providerStatus = useProvidersStore((s) => s.providerStatus);
  const customProviders = useProvidersStore((s) => s.customProviders);

  const hasKey = providerStatus.find((p) => p.id === selectedProvider)?.hasKey;
  // Branch + ahead/behind, read passively from the git store (populated when
  // the Source Control panel opens — the StatusBar never triggers a git call).
  const branch =
    gitStatus && gitStatus.isRepo ? (gitStatus.branch ?? 'detached') : null;
  const ahead = gitStatus && gitStatus.isRepo ? gitStatus.ahead : 0;
  const behind = gitStatus && gitStatus.isRepo ? gitStatus.behind : 0;

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
      {branch ? (
        <span className="flex items-center gap-1 min-w-0" title={`Branch: ${branch}`}>
          <GitBranch size={11} className="shrink-0" />
          <span className="truncate max-w-[160px] text-fg-secondary">{branch}</span>
          {behind > 0 ? <span aria-label="behind">↓{behind}</span> : null}
          {ahead > 0 ? <span aria-label="ahead">↑{ahead}</span> : null}
        </span>
      ) : null}
      <span className="flex-1" aria-hidden />
      {inspectMode ? <span className="text-accent">Inspect on</span> : null}
      {captures.length > 0 ? (
        <span>
          {captures.length} capture{captures.length === 1 ? '' : 's'}
        </span>
      ) : null}
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
          {providerLabel(selectedProvider, customProviders)} · {selectedModel}
        </span>
      </span>
    </footer>
  );
}
