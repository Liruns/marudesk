import { useI18n } from '../../i18n/useI18n';

export function useOnOffOptions() {
  const { t } = useI18n();
  return [
    { value: 'off', label: t('settings.option.off') },
    { value: 'on', label: t('settings.option.on') },
  ] as const;
}
