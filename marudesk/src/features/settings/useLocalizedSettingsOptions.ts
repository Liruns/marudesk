import type { DevtoolsDock } from '../../../shared/settings';
import { useI18n } from '../../i18n/useI18n';

export function useOnOffOptions() {
  const { t } = useI18n();
  return [
    { value: 'off', label: t('settings.option.off') },
    { value: 'on', label: t('settings.option.on') },
  ] as const;
}

/**
 * Localized DevTools dock options. `chrome` is a brand name and stays literal;
 * `right`/`bottom` are translated.
 */
export function useDockOptions() {
  const { t } = useI18n();
  return [
    { value: 'right', label: t('settings.devtools.dock.right') },
    { value: 'bottom', label: t('settings.devtools.dock.bottom') },
    { value: 'chrome', label: 'Chrome' },
  ] as const satisfies readonly {
    readonly value: DevtoolsDock;
    readonly label: string;
  }[];
}
