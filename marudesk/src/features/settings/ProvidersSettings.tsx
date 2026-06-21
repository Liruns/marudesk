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
