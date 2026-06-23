import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { useProvidersStore } from '../providers/store';
import { AddCustomEndpointForm } from './AddCustomEndpointForm';
import { CustomEndpointCard } from './CustomEndpointCard';

export function CustomEndpointsSection() {
  const { t } = useI18n();
  const customProviders = useProvidersStore((s) => s.customProviders);
  const loadCustom = useProvidersStore((s) => s.loadCustomProviders);
  const removeCustom = useProvidersStore((s) => s.removeCustomProvider);
  const error = useProvidersStore((s) => s.customError);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void loadCustom();
  }, [loadCustom]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption uppercase tracking-wider text-fg-tertiary">
          {t('settings.providers.custom.title')}
        </span>
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          className="flex items-center gap-1 text-caption text-fg-tertiary hover:text-accent transition-colors duration-fast"
        >
          <Plus size={12} /> {t('settings.providers.custom.addEndpoint')}
        </button>
      </div>
      <p className="text-caption text-fg-tertiary">
        {t('settings.providers.custom.description')}
      </p>

      {customProviders.length === 0 && !adding ? (
        <p className="text-caption italic text-fg-quaternary">
          {t('settings.providers.custom.empty')}
        </p>
      ) : null}

      {customProviders.map((provider) => (
        <CustomEndpointCard
          key={provider.id}
          provider={provider}
          onRemove={() => void removeCustom(provider.id)}
        />
      ))}

      {adding ? <AddCustomEndpointForm onDone={() => setAdding(false)} /> : null}

      {error ? (
        <div className="text-body-sm text-fg-secondary bg-error-subtle/40 rounded-md px-3 py-2 break-words">
          {error}
        </div>
      ) : null}
    </div>
  );
}
