import { useEffect } from 'react';
import type { WebContextMenuLabels } from '../../../shared/browser';
import { useI18n } from '../../i18n/useI18n';

/**
 * Push the localized web-tab right-click menu labels to the main process. The
 * native context menu is built in main (electron/browser/context-menu.ts), which
 * has no access to the renderer's i18n — locale lives in renderer localStorage —
 * so the renderer is the single source of truth and ships the translated strings
 * over IPC once on mount and again whenever the locale changes. Main caches them
 * and falls back to English before the first push.
 */
export function useSyncWebContextMenuLabels(): void {
  const { t, locale } = useI18n();
  useEffect(() => {
    const labels: WebContextMenuLabels = {
      openLinkNewTab: t('browser.contextMenu.openLinkNewTab'),
      copyLinkAddress: t('browser.contextMenu.copyLinkAddress'),
      openImageNewTab: t('browser.contextMenu.openImageNewTab'),
      saveImage: t('browser.contextMenu.saveImage'),
      copyImage: t('browser.contextMenu.copyImage'),
      copyImageAddress: t('browser.contextMenu.copyImageAddress'),
      addToDictionary: t('browser.contextMenu.addToDictionary'),
      cut: t('browser.contextMenu.cut'),
      copy: t('browser.contextMenu.copy'),
      paste: t('browser.contextMenu.paste'),
      selectAll: t('browser.contextMenu.selectAll'),
      searchWeb: t('browser.contextMenu.searchWeb'),
      back: t('browser.contextMenu.back'),
      forward: t('browser.contextMenu.forward'),
      reload: t('browser.contextMenu.reload'),
      copyPageUrl: t('browser.contextMenu.copyPageUrl'),
      inspectElement: t('browser.contextMenu.inspectElement'),
    };
    void window.marudesk.invoke('browser:set-context-menu-labels', labels);
    // `t` is stable per locale; re-run only when the locale changes.
  }, [t, locale]);
}
