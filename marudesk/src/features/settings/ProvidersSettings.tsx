import { useEffect } from 'react';
import { PROVIDERS } from '../../../shared/providers';
import { useI18n } from '../../i18n/useI18n';
import { useProvidersStore } from '../providers/store';
import { CustomEndpointsSection } from './CustomEndpointsSection';
import { ProviderCard } from './ProviderCard';

export function ProvidersSettings() {
  const { t } = useI18n();
  const status = useProvidersStore((s) => s.providerStatus);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const statusError = useProvidersStore((s) => s.statusError);
  const refreshStatus = useProvidersStore((s) => s.refreshProviderStatus);
  const keyProvider = useProvidersStore((s) => s.keyProvider);
  const selectKeyProvider = useProvidersStore((s) => s.selectKeyProvider);

  useEffect(() => {
    if (!statusChecked) void refreshStatus();
  }, [statusChecked, refreshStatus]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-fg-tertiary">
        {t('settings.providers.description')}
      </p>

      {statusError ? (
        <div
          role="alert"
          title={statusError}
          className="flex items-center justify-between gap-3 rounded-md bg-error-subtle/40 px-3 py-2 text-body-sm text-fg-secondary"
        >
          <span className="break-words">{t('settings.providers.statusError')}</span>
          <button
            type="button"
            onClick={() => void refreshStatus()}
            className="shrink-0 inline-flex items-center rounded px-2 py-0.5 text-caption font-medium text-fg-primary bg-surface-2 hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors duration-fast"
          >
            {t('settings.providers.statusRetry')}
          </button>
        </div>
      ) : null}

      <span className="text-caption uppercase tracking-wider text-fg-tertiary">
        {t('settings.providers.builtinTitle')}
      </span>

      <div className="flex flex-col gap-2">
        {PROVIDERS.map((provider) => {
          const providerStatus = status.find((s) => s.id === provider.id);
          return (
            <ProviderCard
              key={provider.id}
              providerId={provider.id}
              hasKey={!!providerStatus?.hasKey}
              oauthConnected={!!providerStatus?.oauth}
              expanded={keyProvider === provider.id}
              onSelect={() =>
                selectKeyProvider(keyProvider === provider.id ? null : provider.id)
              }
            />
          );
        })}
      </div>

      <div className="h-px bg-subtle" />

      <CustomEndpointsSection />
    </div>
  );
}
