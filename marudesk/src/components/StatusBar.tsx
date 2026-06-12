import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useWebPageStore } from '../features/browser/store';
import { useProvidersStore } from '../features/providers/store';
import { useWorkspaceStore } from '../features/workspace/store';
import { useDiagnosticsStore, diagnosticCounts } from '../features/diagnostics/store';
import { ProblemsPopover } from '../features/diagnostics/ProblemsPopover';
import { useGitStore } from '../features/git/store';
import { openSettingsTab, useSettingsStore } from '../features/settings/store';
import { providerLabel } from '../../shared/providers';
import { UI_ZOOM_MAX, UI_ZOOM_MIN, type AgentApprovalMode } from '../../shared/settings';
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
  const uiZoom = useSettingsStore((s) => s.settings.appearance.uiZoom);
  const updateSettings = useSettingsStore((s) => s.update);
  const diagnosticsState = useDiagnosticsStore((s) => s.state);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const { formatCaptureCount, formatFileCount, t } = useI18n();

  const { errors: diagErrors, warnings: diagWarnings } = diagnosticCounts(diagnosticsState);

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
        <span className="relative flex items-center">
          <button
            type="button"
            onClick={() => setProblemsOpen((v) => !v)}
            aria-expanded={problemsOpen}
            title={t('status.problems.title')}
            className="flex items-center gap-2 hover:text-fg-secondary transition-colors duration-fast"
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
          {problemsOpen ? <ProblemsPopover onClose={() => setProblemsOpen(false)} /> : null}
        </span>
      ) : null}
      <span className="flex-1" aria-hidden />
      <span className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label={t('status.zoom.out')}
          title={t('status.zoom.outTitle')}
          disabled={uiZoom <= UI_ZOOM_MIN}
          onClick={() => void updateSettings({ appearance: { uiZoom: Math.max(UI_ZOOM_MIN, uiZoom - 10) } })}
          className="size-4 flex items-center justify-center hover:text-fg-secondary disabled:opacity-30 transition-colors duration-fast"
        >
          −
        </button>
        <button
          type="button"
          title={t('status.zoom.resetTitle')}
          onClick={() => { if (uiZoom !== 100) void updateSettings({ appearance: { uiZoom: 100 } }); }}
          className={cn(
            'px-1 hover:text-fg-secondary transition-colors duration-fast tabular-nums',
            uiZoom !== 100 && 'text-accent',
          )}
        >
          {uiZoom}%
        </button>
        <button
          type="button"
          aria-label={t('status.zoom.in')}
          title={t('status.zoom.inTitle')}
          disabled={uiZoom >= UI_ZOOM_MAX}
          onClick={() => void updateSettings({ appearance: { uiZoom: Math.min(UI_ZOOM_MAX, uiZoom + 10) } })}
          className="size-4 flex items-center justify-center hover:text-fg-secondary disabled:opacity-30 transition-colors duration-fast"
        >
          +
        </button>
      </span>
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
