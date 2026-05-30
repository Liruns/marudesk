import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { Badge, Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import { PROVIDERS } from '../../../shared/providers';
import { useComposerStore } from '../composer/store';

/**
 * The AI Providers category of Settings — API-key management, per-provider model
 * selection, and a connection test. It reads the key-editor state from the
 * composer store (shared with the Composer's provider picker), so saving a key
 * here immediately unlocks proposals there.
 */
export function ProvidersSettings() {
  const provider = useComposerStore((s) => s.keyProvider);
  const keyInput = useComposerStore((s) => s.keyInput);
  const busy = useComposerStore((s) => s.keyBusy);
  const error = useComposerStore((s) => s.keyError);
  const status = useComposerStore((s) => s.providerStatus);
  const statusChecked = useComposerStore((s) => s.statusChecked);
  const modelsByProvider = useComposerStore((s) => s.modelsByProvider);
  const modelsLoading = useComposerStore(
    (s) => s.modelsLoadingByProvider[provider],
  );
  const modelByProvider = useComposerStore((s) => s.modelByProvider);
  const test = useComposerStore((s) => s.testByProvider[provider]);
  const setProvider = useComposerStore((s) => s.selectKeyProvider);
  const setKey = useComposerStore((s) => s.setKeyInput);
  const setModelFor = useComposerStore((s) => s.setModelFor);
  const save = useComposerStore((s) => s.saveProviderKey);
  const clear = useComposerStore((s) => s.clearProviderKey);
  const refreshStatus = useComposerStore((s) => s.refreshProviderStatus);
  const refreshModels = useComposerStore((s) => s.refreshModels);
  const testConnection = useComposerStore((s) => s.testConnection);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [reveal, setReveal] = useState(false);

  // Make sure the key-status badges reflect disk the first time this opens.
  useEffect(() => {
    if (!statusChecked) void refreshStatus();
  }, [statusChecked, refreshStatus]);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [provider]);

  const def = PROVIDERS.find((p) => p.id === provider);
  const hasKey = !!status.find((s) => s.id === provider)?.hasKey;

  // Populate the live model list for the provider being viewed (only when a key
  // exists — refreshModels no-ops the network call otherwise).
  useEffect(() => {
    if (hasKey) void refreshModels(provider);
  }, [provider, hasKey, refreshModels]);

  if (!def) return null;
  const models = modelsByProvider[provider] ?? def.models;
  const activeModel = modelByProvider[provider] ?? def.defaultModelId;
  const activeModelLabel =
    models.find((m) => m.id === activeModel)?.label ?? activeModel;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-caption text-fg-tertiary">
        Keys are stored encrypted via the OS keychain (safeStorage) — never
        written to disk in plaintext.
      </p>

      {/* Provider switcher */}
      <div role="tablist" aria-label="Providers" className="flex gap-1">
        {PROVIDERS.map((p) => {
          const active = p.id === provider;
          const filled = !!status.find((s) => s.id === p.id)?.hasKey;
          return (
            <button
              key={p.id}
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => setProvider(p.id)}
              className={cn(
                'h-8 flex-1 rounded-md border text-body-sm flex items-center justify-center gap-1.5',
                'transition-colors duration-fast',
                active
                  ? 'border-accent text-fg-primary bg-accent-subtle/30'
                  : 'border-subtle text-fg-tertiary hover:text-fg-secondary hover:border-default',
              )}
            >
              <span>{p.label}</span>
              {filled ? (
                <span aria-hidden className="size-1.5 rounded-pill bg-accent" />
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-subtle bg-surface-1 p-4 flex flex-col gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={hasKey ? 'accent' : 'neutral'}>
            {hasKey ? 'API key set' : 'no key'}
          </Badge>
          <span className="text-caption text-fg-tertiary">{def.apiKeyHint}</span>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-caption uppercase tracking-wider text-fg-tertiary">
            API key
          </span>
          <div className="relative">
            <input
              ref={inputRef}
              key={provider}
              type={reveal ? 'text' : 'password'}
              value={keyInput}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void save();
              }}
              spellCheck={false}
              autoComplete="off"
              placeholder={def.apiKeyPlaceholder}
              className={cn(
                'h-9 w-full rounded-md bg-surface-page border border-default pl-3 pr-9',
                'font-mono text-body-sm text-fg-primary placeholder:text-fg-tertiary',
                'focus:outline-none focus:border-accent transition-colors duration-fast',
              )}
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? 'Hide key' : 'Reveal key'}
              title={reveal ? 'Hide key' : 'Reveal key'}
              className="absolute inset-y-0 right-0 w-9 flex items-center justify-center text-fg-tertiary hover:text-fg-primary transition-colors duration-fast"
            >
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </label>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={busy || keyInput.trim().length === 0}
          >
            {busy ? 'Saving…' : 'Save key'}
          </Button>
          {hasKey ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void testConnection(provider)}
                disabled={busy || test?.status === 'testing'}
              >
                {test?.status === 'testing' ? 'Testing…' : 'Test connection'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void clear()}
                disabled={busy}
              >
                Remove key
              </Button>
            </>
          ) : null}
        </div>

        {/* Model selection — picks the active model used for proposals. */}
        <label className="flex flex-col gap-1.5">
          <span className="text-caption uppercase tracking-wider text-fg-tertiary flex items-center gap-1.5">
            Model
            {modelsLoading ? (
              <Loader2 size={11} className="animate-spin text-fg-tertiary" />
            ) : null}
          </span>
          <select
            value={activeModel}
            onChange={(e) => setModelFor(provider, e.target.value)}
            className={cn(
              'h-9 rounded-md bg-surface-page border border-default px-2.5',
              'text-body-sm text-fg-primary focus:outline-none focus:border-accent',
              'transition-colors duration-fast',
            )}
          >
            {models.some((m) => m.id === activeModel) ? null : (
              <option value={activeModel}>{activeModelLabel}</option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="text-caption text-fg-tertiary">
            {hasKey
              ? 'Live list fetched from the provider; falls back to the built-in catalog.'
              : 'Add a key to fetch the live model list.'}
          </span>
        </label>

        {test && test.status !== 'idle' && test.status !== 'testing' ? (
          <div
            className={cn(
              'flex items-start gap-2 rounded-md px-3 py-2 text-body-sm break-words',
              test.status === 'ok'
                ? 'bg-success-subtle/40 text-fg-secondary'
                : 'bg-error-subtle/40 text-fg-secondary',
            )}
          >
            {test.status === 'ok' ? (
              <CheckCircle2 size={14} className="text-success shrink-0 mt-0.5" />
            ) : (
              <AlertCircle size={14} className="text-error shrink-0 mt-0.5" />
            )}
            <span>{test.message}</span>
          </div>
        ) : null}

        {error ? (
          <div className="text-body-sm text-fg-secondary bg-error-subtle/40 rounded-md px-3 py-2 break-words">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
