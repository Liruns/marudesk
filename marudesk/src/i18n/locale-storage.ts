import { parseLocale, type Locale } from './messages';

/**
 * The localStorage key the locale choice persists under. Shared between the
 * I18nProvider (which owns writes) and non-React code that needs the locale
 * outside the provider tree, so the literal can't drift across files.
 */
export const LOCALE_STORAGE_KEY = 'marudesk.locale';

/**
 * The persisted locale right now, for non-React modules (store reducers,
 * formatters) that resolve messages outside the React context. Falls back to
 * 'en' when storage is unavailable or holds an unknown value.
 */
export function currentLocale(): Locale {
  try {
    return parseLocale(localStorage.getItem(LOCALE_STORAGE_KEY)) ?? 'en';
  } catch {
    return 'en';
  }
}
