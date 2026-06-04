import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { CustomProviderInfo } from '../../../shared/providers';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { useProvidersStore } from '../providers/store';

export function CustomEndpointKeyEditor({
  provider,
}: {
  readonly provider: CustomProviderInfo;
}) {
  const { t } = useI18n();
  const setCustomKey = useProvidersStore((s) => s.setCustomKey);
  const clearCustomKey = useProvidersStore((s) => s.clearCustomKey);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (value.trim().length === 0 || busy) return;
    setBusy(true);
    await setCustomKey(provider.id, value.trim());
    setBusy(false);
    setValue('');
  };

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-caption uppercase tracking-wider text-fg-tertiary">
        {t('settings.providers.apiKey')}{' '}
        {provider.hasKey
          ? t('settings.providers.custom.keyStored')
          : t('settings.providers.custom.keyOptional')}
      </span>
      <div className="relative">
        <input
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder={
            provider.hasKey
              ? t('settings.providers.custom.replacePlaceholder')
              : t('settings.providers.custom.optionalPlaceholder')
          }
          className={cn(
            'h-9 w-full rounded-md bg-surface-page border border-default pl-3 pr-9',
            'font-mono text-body-sm text-fg-primary placeholder:text-fg-tertiary',
            'focus:outline-none focus:border-accent transition-colors duration-fast',
          )}
        />
        <button
          type="button"
          onClick={() => setReveal((next) => !next)}
          aria-label={
            reveal
              ? t('settings.providers.hideKey')
              : t('settings.providers.revealKey')
          }
          className="absolute inset-y-0 right-0 w-9 flex items-center justify-center text-fg-tertiary hover:text-fg-primary transition-colors duration-fast"
        >
          {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={busy || value.trim().length === 0}
        >
          {busy ? t('settings.providers.saving') : t('settings.providers.saveKey')}
        </Button>
        {provider.hasKey ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void clearCustomKey(provider.id)}
            disabled={busy}
          >
            {t('settings.providers.removeKey')}
          </Button>
        ) : null}
      </div>
    </label>
  );
}
