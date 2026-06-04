import { createContext, useContext } from 'react';
import type {
  FileCountInput,
  Locale,
  SearchSummaryInput,
  TranslationKey,
} from './messages';

export type I18nContextValue = {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: (key: TranslationKey) => string;
  readonly formatFileCount: (input: FileCountInput) => string;
  readonly formatCaptureCount: (count: number) => string;
  readonly formatMcpToolCount: (count: number) => string;
  readonly formatProviderModelCount: (count: number) => string;
  readonly formatWorkspaceTruncated: (count: number) => string;
  readonly formatSearchSummary: (input: SearchSummaryInput) => string;
  readonly formatSearchNoResults: (query: string) => string;
  readonly formatSearchMatchLineTitle: (line: number) => string;
  readonly formatQuickOpenNoMatch: (query: string) => string;
  readonly formatTabPaletteNoMatch: (query: string) => string;
};

class I18nProviderMissingError extends Error {
  constructor() {
    super('useI18n must be used inside I18nProvider.');
    this.name = 'I18nProviderMissingError';
  }
}

export const I18nContext = createContext<I18nContextValue | null>(null);

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (value === null) throw new I18nProviderMissingError();
  return value;
}
