import { EN_MESSAGES } from './messages.en';
import { KO_MESSAGES } from './messages.ko';

export const LOCALE_OPTIONS = [
  { value: 'en', label: 'English', nativeLabel: 'English' },
  { value: 'ko', label: 'Korean', nativeLabel: '한국어' },
] as const;

export type Locale = (typeof LOCALE_OPTIONS)[number]['value'];

export type TranslationKey = keyof typeof EN_MESSAGES;
type Messages = Readonly<Record<TranslationKey, string>>;
export type FileCountInput = {
  readonly count: number;
  readonly truncated: boolean;
};
export type SearchSummaryInput = {
  readonly totalMatches: number;
  readonly fileCount: number;
  readonly truncated: boolean;
};
type LocaleFormatters = {
  readonly fileCount: (input: FileCountInput) => string;
  readonly captureCount: (count: number) => string;
  readonly mcpToolCount: (count: number) => string;
  readonly providerModelCount: (count: number) => string;
  readonly workspaceTruncated: (count: number) => string;
  readonly searchSummary: (input: SearchSummaryInput) => string;
  readonly searchNoResults: (query: string) => string;
  readonly searchMatchLineTitle: (line: number) => string;
  readonly quickOpenNoMatch: (query: string) => string;
  readonly tabPaletteNoMatch: (query: string) => string;
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = {
  en: EN_MESSAGES,
  ko: KO_MESSAGES,
};

export function getMessage(locale: Locale, key: TranslationKey): string {
  return MESSAGES[locale][key];
}

const FORMATTERS: Readonly<Record<Locale, LocaleFormatters>> = {
  en: {
    fileCount: ({ count, truncated }) => `${count}${truncated ? '+' : ''} files`,
    captureCount: (count) => `${count} capture${count === 1 ? '' : 's'}`,
    mcpToolCount: (count) => `${count} tool${count === 1 ? '' : 's'}`,
    providerModelCount: (count) => `${count} model${count === 1 ? '' : 's'}`,
    workspaceTruncated: (count) => `Showing the first ${count} files.`,
    searchSummary: ({ totalMatches, fileCount, truncated }) =>
      `${totalMatches} result${totalMatches === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}${truncated ? ' (showing first matches)' : ''}`,
    searchNoResults: (query) => `No results for "${query}".`,
    searchMatchLineTitle: (line) => `Line ${line}`,
    quickOpenNoMatch: (query) => `No files match “${query}”.`,
    tabPaletteNoMatch: (query) => `No tabs match “${query}”.`,
  },
  ko: {
    fileCount: ({ count, truncated }) => `${count}${truncated ? '+' : ''}개 파일`,
    captureCount: (count) => `${count}개 캡처`,
    mcpToolCount: (count) => `도구 ${count}개`,
    providerModelCount: (count) => `모델 ${count}개`,
    workspaceTruncated: (count) => `처음 ${count}개 파일만 표시 중입니다.`,
    searchSummary: ({ totalMatches, fileCount, truncated }) =>
      `${fileCount}개 파일에서 ${totalMatches}개 결과${truncated ? ' (처음 일치만 표시)' : ''}`,
    searchNoResults: (query) => `“${query}”에 대한 결과가 없습니다.`,
    searchMatchLineTitle: (line) => `${line}줄`,
    quickOpenNoMatch: (query) => `“${query}”와 일치하는 파일이 없습니다.`,
    tabPaletteNoMatch: (query) => `“${query}”와 일치하는 탭이 없습니다.`,
  },
};

/**
 * Build a locale-aware formatter for a single {@link LocaleFormatters} key. Each
 * `format<Name>ForLocale` export below dispatches identically — pick the active
 * locale's table, then call its entry — so the wrapper is generated rather than
 * hand-written per key. `Parameters<…>[0]` preserves each formatter's exact
 * argument type at the call site.
 */
function makeLocaleFormatter<K extends keyof LocaleFormatters>(
  key: K,
): (locale: Locale, input: Parameters<LocaleFormatters[K]>[0]) => string {
  return (locale, input) =>
    (FORMATTERS[locale][key] as (arg: Parameters<LocaleFormatters[K]>[0]) => string)(input);
}

export const formatFileCountForLocale = makeLocaleFormatter('fileCount');
export const formatCaptureCountForLocale = makeLocaleFormatter('captureCount');
export const formatMcpToolCountForLocale = makeLocaleFormatter('mcpToolCount');
export const formatProviderModelCountForLocale = makeLocaleFormatter('providerModelCount');
export const formatWorkspaceTruncatedForLocale = makeLocaleFormatter('workspaceTruncated');
export const formatSearchSummaryForLocale = makeLocaleFormatter('searchSummary');
export const formatSearchNoResultsForLocale = makeLocaleFormatter('searchNoResults');
export const formatSearchMatchLineTitleForLocale = makeLocaleFormatter('searchMatchLineTitle');
export const formatQuickOpenNoMatchForLocale = makeLocaleFormatter('quickOpenNoMatch');
export const formatTabPaletteNoMatchForLocale = makeLocaleFormatter('tabPaletteNoMatch');

export function parseLocale(value: unknown): Locale | null {
  switch (value) {
    case 'en':
      return 'en';
    case 'ko':
      return 'ko';
    default:
      return null;
  }
}
