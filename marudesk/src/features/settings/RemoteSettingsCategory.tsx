import { useI18n } from '../../i18n/useI18n';
import { Field, Section, Segmented } from './SettingsControls';
import { useSettingsStore } from './store';
import { DevicePairing } from './RemoteDevicePairing';
import { CloudRelaySection } from './RemoteRelaySection';
import { RemoteGuide } from './RemoteGuide';
import { AdvancedRemote } from './AdvancedRemoteSettings';
import { useOnOffOptions } from './useLocalizedSettingsOptions';

export function RemoteCategory() {
  const { t } = useI18n();
  const onOffOptions = useOnOffOptions();
  const server = useSettingsStore((s) => s.settings.server);
  const update = useSettingsStore((s) => s.update);
  return (
    <div className="flex flex-col gap-6">
      <Section>
        <Field
          label={t('settings.remote.phoneAccess.label')}
          hint={t('settings.remote.phoneAccess.hint')}
        >
          <Segmented
            value={server.enabled ? 'on' : 'off'}
            options={onOffOptions}
            ariaLabel={t('settings.remote.phoneAccess.label')}
            onChange={(v) => void update({ server: { enabled: v === 'on' } })}
          />
        </Field>
      </Section>

      {server.enabled ? <DevicePairing /> : null}

      <RemoteGuide />

      {server.enabled ? <AdvancedRemote /> : null}

      <header className="flex flex-col gap-1">
        <h3 className="text-body font-medium text-fg-primary">
          {t('settings.remote.cloud.title')}
        </h3>
        <p className="text-caption text-fg-tertiary">
          {t('settings.remote.cloud.description')}
        </p>
      </header>
      <CloudRelaySection />
    </div>
  );
}
