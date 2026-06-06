import { GitBranch } from 'lucide-react';
import { useWebPageStore } from '../features/browser/store';
import { useProvidersStore } from '../features/providers/store';
import { useWorkspaceStore } from '../features/workspace/store';
import { useDiagnosticsStore, diagnosticCounts } from '../features/diagnostics/store';
import { useGitStore } from '../features/git/store';
import { openSettingsTab, useSettingsStore } from '../features/settings/store';
import { providerLabel } from '../../shared/providers';
import type { AgentApprovalMode } from '../../shared/settings';
import { cn } from '../lib/cn';
import { useI18n } from '../i18n/useI18n';
import type { TranslationKey } from '../i18n/messages';

/**
 * VSCode-style status strip pinned to the bottom of the window. Surfaces the
 * always-relevant facts that used to live in the header (workspace name, file
 * count) plus runtime status (inspect on, active model).
 *
 * Kept thin (24px) so it costs almost nothing vertically — the browser stage
 * is the canvas, this is just chrome.
 */
const APPROVAL_LABEL_KEY: Record<AgentApprovalMode, TranslationKey> = {
  plan: 'status.approval.plan',
  'read-only': 'status.approval.readOnly',
  ask: 'status.approval.ask',
  auto: 'status.approval.auto',
};
/** Dot hue per mode: neutral (safe/plan), accent (default), warning (hands-free). */
const APPROVAL_DOT: Record<AgentApprovalMode, string> = {
  plan: 'bg-fg-tertiary/40',
  'read-only': 'bg-fg-tertiary/40',
  ask: 'bg-accent',
  auto: 'bg-warning',
};

export function StatusBar() {
  const summary = useWorkspaceStore((s) => s.summary);
  const gitStatus = useGitStore((s) => s.status);
  const inspectMode = useWebPageStore((s) => s.inspectMode);
  const captures = useWebPageStore((s) => s.captures);
  const selectedProvider = useProvidersStore((s) => s.selectedProvider);
  const selectedModel = useProvidersStore((s) => s.selectedModel);
  const providerStatus = useProvidersStore((s) => s.providerStatus);
  const customProviders = useProvidersStore((s) => s.customProviders);
  const approvalMode = useSettingsStore((s) => s.settings.agent.approvalMode);
  const diagnosticsState = useDiagnosticsStore((s) => s.state);
  const runDiagnostics = useDiagnosticsStore((s) => s.run);
  const { formatCaptureCount, formatFileCount, t } = useI18n();

  const { errors: diagErrors, warnings: diagWarnings } = diagnosticCounts(diagnosticsState);
  const diagHasRun = diagnosticsState.lastRun !== null;

  const hasKey = providerStatus.find((p) => p.id === selectedProvider)?.hasKey;
  // Branch + ahead/behind, read passively from the git store (populated when
  // the Source Control panel opens — the StatusBar never triggers a git call).
  const branch =
    gitStatus && gitStatus.isRepo ? (gitStatus.branch ?? 'detached') : null;
  const ahead = gitStatus && gitStatus.isRepo ? gitStatus.ahead : 0;
  const behind = gitStatus && gitStatus.isRepo ? gitStatus.behind : 0;
  const fileCount = summary
    ? formatFileCount({
        count: summary.files.length,
        truncated: summary.truncated,
      })
    : '';
  const captureCount = formatCaptureCount(captures.length);

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
            <span>{fileCount}</span>
          </>
        ) : (
          <>
            <span
              aria-hidden
              className="size-1.5 rounded-pill bg-fg-tertiary/40 shrink-0"
            />
            <span>{t('status.noWorkspace')}</span>
          </>
        )}
      </span>
      {branch ? (
        <span
          className="flex items-center gap-1 min-w-0"
          title={`${t('status.branchTitle')}: ${branch}`}
        >
          <GitBranch size={11} className="shrink-0" />
          <span className="truncate max-w-[160px] text-fg-secondary">{branch}</span>
          {behind > 0 ? <span aria-label={t('status.behind')}>↓{behind}</span> : null}
          {ahead > 0 ? <span aria-label={t('status.ahead')}>↑{ahead}</span> : null}
        </span>
      ) : null}
      {summary ? (
        <button
          type="button"
          onClick={() => void runDiagnostics()}
          disabled={diagnosticsState.running}
          title={
            diagnosticsState.running
              ? 'Running the project checker…'
              : diagHasRun
                ? 'Re-run the project type-check / diagnostics'
                : 'Run the project type-check / diagnostics'
          }
          className="flex items-center gap-2 hover:text-fg-secondary transition-colors duration-fast disabled:opacity-60"
        >
          {diagnosticsState.running ? (
            <span>checking…</span>
          ) : (
            <>
              <span className={cn('flex items-center gap-1', diagErrors > 0 && 'text-error')}>
                ✖ {diagErrors}
              </span>
              <span className={cn('flex items-center gap-1', diagWarnings > 0 && 'text-warning')}>
                ⚠ {diagWarnings}
              </span>
            </>
          )}
        </button>
      ) : null}
      <span className="flex-1" aria-hidden />
      {inspectMode ? <span className="text-accent">{t('status.inspectOn')}</span> : null}
      {captures.length > 0 ? (
        <span>{captureCount}</span>
      ) : null}
      <button
        type="button"
        onClick={() => void openSettingsTab('agent')}
        title={t('status.approvalTitle')}
        className="flex items-center gap-1.5 hover:text-fg-secondary transition-colors duration-fast"
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-pill shrink-0',
            APPROVAL_DOT[approvalMode],
          )}
        />
        <span>{t(APPROVAL_LABEL_KEY[approvalMode])}</span>
      </button>
      <button
        type="button"
        onClick={() => void openSettingsTab('providers')}
        title={
          hasKey
            ? t('status.modelProviderTitle')
            : t('status.noApiKeyTitle')
        }
        className="flex items-center gap-1.5 hover:text-fg-secondary transition-colors duration-fast"
      >
        <span
          aria-hidden
          className={
            hasKey
              ? 'size-1.5 rounded-pill bg-accent shrink-0'
              : 'size-1.5 rounded-pill bg-warning shrink-0'
          }
        />
        <span className="truncate max-w-[280px]">
          {providerLabel(selectedProvider, customProviders)} · {selectedModel}
        </span>
      </button>
    </footer>
  );
}
