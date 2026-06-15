import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  formatCanvasGroupSectionForLocale,
  formatCaptureCountForLocale,
  formatFileCountForLocale,
  formatMcpToolCountForLocale,
  formatProviderModelCountForLocale,
  formatQuickOpenNoMatchForLocale,
  formatSearchMatchLineTitleForLocale,
  formatSearchNoResultsForLocale,
  formatSearchSummaryForLocale,
  formatTabPaletteNoMatchForLocale,
  formatWorkspaceTruncatedForLocale,
  MESSAGES,
  parseLocale,
  type Locale,
} from './messages';
import { I18nContext, type I18nContextValue } from './useI18n';
import { LOCALE_STORAGE_KEY } from './locale-storage';

function detectInitialLocale(): Locale {
  try {
    const stored = parseLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
    if (stored) return stored;
  } catch (error) {
    if (error instanceof DOMException) return 'en';
    throw error;
  }

  return 'en';
}

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch (error) {
      if (error instanceof DOMException) return;
      throw error;
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key) => MESSAGES[locale][key],
      formatFileCount: (input) => formatFileCountForLocale(locale, input),
      formatCanvasGroupSection: (count) =>
        formatCanvasGroupSectionForLocale(locale, count),
      formatCaptureCount: (count) =>
        formatCaptureCountForLocale(locale, count),
      formatMcpToolCount: (count) =>
        formatMcpToolCountForLocale(locale, count),
      formatProviderModelCount: (count) =>
        formatProviderModelCountForLocale(locale, count),
      formatWorkspaceTruncated: (count) =>
        formatWorkspaceTruncatedForLocale(locale, count),
      formatSearchSummary: (input) =>
        formatSearchSummaryForLocale(locale, input),
      formatSearchNoResults: (query) =>
        formatSearchNoResultsForLocale(locale, query),
      formatSearchMatchLineTitle: (line) =>
        formatSearchMatchLineTitleForLocale(locale, line),
      formatQuickOpenNoMatch: (query) =>
        formatQuickOpenNoMatchForLocale(locale, query),
      formatTabPaletteNoMatch: (query) =>
        formatTabPaletteNoMatchForLocale(locale, query),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
