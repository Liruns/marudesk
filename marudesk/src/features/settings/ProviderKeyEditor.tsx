import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { getProvider, type BuiltinProviderId } from '../../../shared/providers';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { useProvidersStore } from '../providers/store';

export function ProviderKeyEditor({
  providerId,
  hasKey,
}: {
  readonly providerId: BuiltinProviderId;
  readonly hasKey: boolean;
}) {
  const { t } = useI18n();
  const provider = getProvider(providerId);
  const keyInput = useProvidersStore((s) => s.keyInput);
  const busy = useProvidersStore((s) => s.keyBusy);
  const error = useProvidersStore((s) => s.keyError);
  const test = useProvidersStore((s) => s.testByProvider[providerId]);
  const setKey = useProvidersStore((s) => s.setKeyInput);
  const save = useProvidersStore((s) => s.saveProviderKey);
  const clear = useProvidersStore((s) => s.clearProviderKey);
  const testConnection = useProvidersStore((s) => s.testConnection);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [reveal, setReveal] = useState(false);

  // Inline format check: the static, non-"…" lead of the placeholder is a strong
  // prefix signal (e.g. "sk-ant-"). Warn only when it's distinctive enough to
  // avoid false positives on generic placeholders.
  const expectedPrefix = provider.apiKeyPlaceholder.split('...')[0]?.trim() ?? '';
  const prefixMismatch =
    expectedPrefix.length >= 4 &&
    /[-_]/.test(expectedPrefix) &&
    keyInput.trim().length > 0 &&
    !keyInput.trim().startsWith(expectedPrefix);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <span className="text-caption text-fg-tertiary">
        {provider.apiKeyHint}
      </span>

      <label className="flex flex-col gap-1.5">
        <span className="text-caption uppercase tracking-wider text-fg-tertiary">
          {t('settings.providers.apiKey')}
        </span>
        <div className="relative">
          <input
            ref={inputRef}
            type={reveal ? 'text' : 'password'}
            value={keyInput}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) void save();
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder={provider.apiKeyPlaceholder}
            className={cn(
              'h-9 w-full rounded-md bg-surface-page border border-default pl-3 pr-9',
              'font-mono text-body-sm text-fg-primary placeholder:text-fg-tertiary',
              'focus:outline-none focus:border-accent transition-colors duration-fast',
            )}
          />
          <button
            type="button"
            onClick={() => setReveal((value) => !value)}
            aria-label={
              reveal
                ? t('settings.providers.hideKey')
                : t('settings.providers.revealKey')
            }
            className="absolute inset-y-0 right-0 w-9 flex items-center justify-center text-fg-secondary hover:text-fg-primary transition-colors duration-fast"
          >
            {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        {prefixMismatch ? (
          <span className="text-caption text-warning">
            {t('settings.providers.keyHintMismatch').replace('{prefix}', expectedPrefix)}
          </span>
        ) : null}
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={busy || keyInput.trim().length === 0}
        >
          {busy ? t('settings.providers.saving') : t('settings.providers.saveKey')}
        </Button>
        {hasKey ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void testConnection(providerId)}
              disabled={busy || test?.status === 'testing'}
            >
              {test?.status === 'testing'
                ? t('settings.providers.testing')
                : t('settings.providers.testConnection')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void clear()}
              disabled={busy}
            >
              {t('settings.providers.removeKey')}
            </Button>
          </>
        ) : null}
      </div>

      {test && test.status !== 'idle' && test.status !== 'testing' ? (
        <div
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-2 text-body-sm break-words',
            test.status === 'ok'
              ? 'border-success/30 bg-success-subtle text-fg-primary'
              : 'border-error/30 bg-error-subtle text-fg-primary',
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
        <div className="text-body-sm text-fg-primary border border-error/30 bg-error-subtle rounded-md px-3 py-2 break-words">
          {error}
        </div>
      ) : null}
    </div>
  );
}
