import type { NavState } from '../../../shared/browser';
import type { DownloadEntry } from '../../../shared/downloads';
import { useI18n } from '../../i18n/useI18n';

export function useBrowserStrings() {
  const { locale, t } = useI18n();

  const formatZoomResetAria = (zoomPct: number): string =>
    `${t('browser.zoom.resetAriaBefore')}${zoomPct}${t('browser.zoom.resetAriaAfter')}`;

  const formatDevtoolsToggleLabel = (errorCount: number): string => {
    return errorCount > 0
      ? locale === 'en'
        ? `Toggle DevTools (F12) - ${errorCount} console error${errorCount === 1 ? '' : 's'}`
        : `${t('browser.devtools.toggle')} - ${t('browser.devtools.errorsBefore')}${errorCount}${t('browser.devtools.errorsAfter')}`
      : t('browser.devtools.toggle');
  };

  const formatInspectHint = (): string => t('browser.inspect.hint');

  const formatDownloadStatus = (entry: DownloadEntry): string => {
    const { state, receivedBytes, totalBytes } = entry;
    if (state === 'completed') return formatBytes(receivedBytes);
    if (state === 'cancelled') return t('browser.downloads.status.cancelled');
    if (state === 'interrupted') return t('browser.downloads.status.failed');
    if (state === 'paused') {
      return `${t('browser.downloads.status.pausedPrefix')}${formatBytes(receivedBytes)}`;
    }
    if (totalBytes > 0) {
      return `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`;
    }
    return formatBytes(receivedBytes);
  };

  const formatSchemeTitle = (isSecure: NavState['isSecure']): string =>
    isSecure
      ? t('browser.security.secure.title')
      : t('browser.security.insecure.title');

  return {
    t,
    formatDevtoolsToggleLabel,
    formatDownloadStatus,
    formatInspectHint,
    formatSchemeTitle,
    formatZoomResetAria,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
