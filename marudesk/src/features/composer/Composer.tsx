import { useEffect, useMemo } from 'react';
import {
  Sparkles,
  ExternalLink,
  Settings as SettingsIcon,
  FolderOpen,
  MousePointerClick,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { Badge, Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import { PROVIDERS } from '../../../shared/providers';
import type { ProposeResult } from '../../../shared/composer';
import { useWebPageStore } from '../browser/store';
import { useWorkspaceStore } from '../workspace/store';
import { openSettingsTab } from '../settings/store';
import { useComposerStore } from './store';

export function Composer() {
  const summary = useWorkspaceStore((s) => s.summary);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const captures = useWebPageStore((s) => s.captures);
  const selectedIds = useWebPageStore((s) => s.selectedCaptureIds);
  const setInspect = useWebPageStore((s) => s.setInspect);

  const prompt = useComposerStore((s) => s.prompt);
  const setPrompt = useComposerStore((s) => s.setPrompt);
  const proposing = useComposerStore((s) => s.proposing);
  const lastResult = useComposerStore((s) => s.lastResult);
  const propose = useComposerStore((s) => s.propose);
  const setTab = useComposerStore((s) => s.setTab);

  const selectedProvider = useComposerStore((s) => s.selectedProvider);
  const selectedModel = useComposerStore((s) => s.selectedModel);
  const setSelectedProvider = useComposerStore((s) => s.setSelectedProvider);
  const setSelectedModel = useComposerStore((s) => s.setSelectedModel);

  const providerStatus = useComposerStore((s) => s.providerStatus);
  const statusChecked = useComposerStore((s) => s.statusChecked);
  const refreshStatus = useComposerStore((s) => s.refreshProviderStatus);
  const selectKeyProvider = useComposerStore((s) => s.selectKeyProvider);
  // Jump to the unified Settings tab's AI Providers category, pre-selecting the
  // provider the composer is currently set to.
  const openProviderSettings = () => {
    selectKeyProvider(selectedProvider);
    void openSettingsTab('providers');
  };

  const modelsByProvider = useComposerStore((s) => s.modelsByProvider);
  const modelsLoading = useComposerStore(
    (s) => s.modelsLoadingByProvider[selectedProvider],
  );
  const modelsError = useComposerStore(
    (s) => s.modelsErrorByProvider[selectedProvider],
  );

  useEffect(() => {
    if (!statusChecked) void refreshStatus();
  }, [statusChecked, refreshStatus]);

  const hasKey = !!providerStatus.find((s) => s.id === selectedProvider)
    ?.hasKey;
  const selectedCount = useMemo(() => {
    let n = 0;
    for (const c of captures) if (selectedIds.has(c.id)) n++;
    return n;
  }, [captures, selectedIds]);
  const promptFilled = prompt.trim().length > 0;

  const canPropose =
    !!summary && hasKey && selectedCount > 0 && promptFilled && !proposing;

  const models = modelsByProvider[selectedProvider] ?? [];

  return (
    <div className="flex flex-col h-full">
      <section className="px-4 py-3 border-b border-subtle flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption uppercase tracking-wider text-fg-tertiary">
            Provider
          </span>
          {modelsLoading ? (
            <span className="flex items-center gap-1 text-caption text-fg-tertiary">
              <Loader2 size={11} className="animate-spin" />
              fetching models
            </span>
          ) : null}
        </div>
        <div role="tablist" aria-label="Provider" className="flex gap-1">
          {PROVIDERS.map((p) => {
            const active = p.id === selectedProvider;
            const filled = !!providerStatus.find((s) => s.id === p.id)?.hasKey;
            return (
              <button
                key={p.id}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setSelectedProvider(p.id)}
                className={cn(
                  'h-7 flex-1 rounded border text-caption flex items-center justify-center gap-1.5 transition-colors duration-fast',
                  active
                    ? 'border-accent text-fg-primary bg-accent-subtle/30'
                    : 'border-subtle text-fg-tertiary hover:text-fg-secondary hover:border-default',
                )}
              >
                <span>{p.label}</span>
                {filled ? (
                  <span
                    aria-hidden
                    className="size-1.5 rounded-pill bg-accent"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-caption uppercase tracking-wider text-fg-tertiary">
            Model
          </span>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={models.length === 0}
            className="h-8 rounded bg-surface-page border border-default px-2 text-body-sm text-fg-primary focus:outline-none focus:border-accent disabled:opacity-50"
          >
            {models.length === 0 ? (
              <option value="">No models available</option>
            ) : (
              <>
                {/* Keep a persisted choice visible even if it's not in the
                    freshly-fetched list (e.g. a renamed/retired model). */}
                {models.some((m) => m.id === selectedModel) ? null : (
                  <option value={selectedModel}>{selectedModel}</option>
                )}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </>
            )}
          </select>
          {modelsError ? (
            <span
              className="text-caption text-warning truncate"
              title={modelsError}
            >
              {modelsError}
            </span>
          ) : null}
        </label>
        {!hasKey && statusChecked ? (
          <div className="flex items-center justify-between gap-2 rounded border border-subtle bg-surface-2 px-2 py-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <Badge variant="neutral">no key</Badge>
              <span className="text-caption text-fg-tertiary truncate">
                Add an API key in Settings to enable proposals.
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<SettingsIcon size={14} />}
              onClick={openProviderSettings}
            >
              Settings
            </Button>
          </div>
        ) : null}
      </section>

      <section className="flex-1 min-h-0 flex flex-col">
        <header className="px-4 py-2 flex items-center justify-between">
          <span className="text-caption uppercase tracking-wider text-fg-tertiary">
            Prompt
          </span>
          <span className="text-caption text-fg-tertiary tabular-nums">
            {selectedCount} of {captures.length} capture
            {captures.length === 1 ? '' : 's'} selected
          </span>
        </header>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the change. The selected captures and their top ranked source files are bundled as context."
          spellCheck={false}
          className={cn(
            'flex-1 min-h-[120px] w-full resize-none bg-surface-page px-4 py-3',
            'font-mono text-body-sm text-fg-primary placeholder:text-fg-tertiary',
            'leading-relaxed',
            'border-t border-subtle',
            'focus:outline-none',
          )}
          aria-label="Composer prompt"
        />
      </section>

      <section className="px-4 py-3 border-t border-subtle flex flex-col gap-2">
        {!canPropose && !proposing ? (
          <ul
            className="flex flex-col gap-1 rounded border border-subtle bg-surface-2/60 px-3 py-2"
            aria-label="Propose prerequisites"
          >
            <ChecklistItem
              ok={!!summary}
              label="Workspace open"
              actionLabel="Open"
              onAction={() => void openWorkspace()}
              actionIcon={<FolderOpen size={12} />}
            />
            <ChecklistItem
              ok={hasKey}
              label={`${getProviderLabel(selectedProvider)} API key`}
              actionLabel="Settings"
              onAction={openProviderSettings}
              actionIcon={<SettingsIcon size={12} />}
            />
            <ChecklistItem
              ok={selectedCount > 0}
              label={
                captures.length === 0
                  ? 'Capture an element (Inspect)'
                  : 'Select at least one capture'
              }
              actionLabel={captures.length === 0 ? 'Inspect' : 'Captures'}
              onAction={() => {
                if (captures.length === 0) {
                  void setInspect(true);
                } else {
                  setTab('captures');
                }
              }}
              actionIcon={<MousePointerClick size={12} />}
            />
            <ChecklistItem
              ok={promptFilled}
              label="Prompt typed"
            />
          </ul>
        ) : null}
        <Button
          variant="primary"
          size="md"
          leadingIcon={<Sparkles size={14} />}
          onClick={() => void propose()}
          disabled={!canPropose}
        >
          {proposing ? 'Proposing…' : 'Propose patch'}
        </Button>

        {lastResult && lastResult.ok ? (
          <div className="rounded border border-subtle bg-surface-2 p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption uppercase tracking-wider text-fg-tertiary">
                Last proposal
              </span>
              <span className="text-caption text-fg-tertiary tabular-nums">
                {lastResult.ops.length} op
                {lastResult.ops.length === 1 ? '' : 's'} · in{' '}
                {lastResult.usage.inputTokens}/ out{' '}
                {lastResult.usage.outputTokens}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="neutral">{lastResult.provider}</Badge>
              <span className="text-caption text-fg-tertiary font-mono">
                {lastResult.model}
              </span>
            </div>
            {lastResult.rationale ? (
              <p className="text-body-sm text-fg-secondary break-words">
                {lastResult.rationale}
              </p>
            ) : null}
            {lastResult.ops.length > 0 ? (
              <>
                <ul className="flex flex-col gap-1">
                  {lastResult.ops.map((op, i) => (
                    <li
                      key={i}
                      className="font-mono text-caption text-fg-secondary truncate"
                      title={op.path}
                    >
                      {op.oldString.length === 0 ? '+ ' : '~ '}
                      {op.path}
                    </li>
                  ))}
                </ul>
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<ExternalLink size={14} />}
                  onClick={() => {
                    window.location.hash = '/dev/patch';
                  }}
                >
                  Open in Patch composer
                </Button>
              </>
            ) : (
              <div className="text-body-sm text-fg-tertiary">
                Model returned no ops.
              </div>
            )}
          </div>
        ) : null}
        {renderFailureBanner(lastResult)}
      </section>
    </div>
  );
}

function getProviderLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

function FailureBanner({ reason }: { reason: string }) {
  return (
    <div className="rounded border border-subtle bg-error-subtle/40 px-3 py-2 text-body-sm text-fg-secondary break-words">
      {reason}
    </div>
  );
}

function renderFailureBanner(
  result: ProposeResult | null,
): React.ReactElement | null {
  if (!result || result.ok === true) return null;
  // After the guard, `result.ok === false` so this is ProposeErr.
  return <FailureBanner reason={result.reason} />;
}

function ChecklistItem({
  ok,
  label,
  actionLabel,
  onAction,
  actionIcon,
}: {
  ok: boolean;
  label: string;
  actionLabel?: string;
  onAction?: () => void;
  actionIcon?: React.ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-2 min-h-[20px]">
      <span
        className={cn(
          'flex items-center gap-1.5 text-caption',
          ok ? 'text-fg-tertiary' : 'text-fg-secondary',
        )}
      >
        {ok ? (
          <CheckCircle2 size={12} className="text-accent shrink-0" />
        ) : (
          <AlertCircle size={12} className="text-warning shrink-0" />
        )}
        <span className={ok ? 'line-through opacity-70' : ''}>{label}</span>
      </span>
      {!ok && actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-accent transition-colors duration-fast"
        >
          {actionIcon}
          <span>{actionLabel}</span>
        </button>
      ) : null}
    </li>
  );
}
