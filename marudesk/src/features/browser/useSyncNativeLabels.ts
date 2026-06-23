import { useEffect } from 'react';
import type { WebContextMenuLabels } from '../../../shared/browser';
import type { DialogLabels, TrayLabels } from '../../../shared/app-info';
import { useI18n } from '../../i18n/useI18n';

/**
 * Push the labels for native surfaces that the main process builds — the web-tab
 * right-click menu, the close-to-tray menu, and the native file-dialog titles —
 * to main. Those surfaces live in the main process, which has no access to the
 * renderer's i18n (locale lives in renderer localStorage), so the renderer stays
 * the single source of truth and ships the translated strings over IPC once on
 * mount and again whenever the locale changes. Main caches them and falls back to
 * English before the first push.
 */
export function useSyncNativeLabels(): void {
  const { t, locale } = useI18n();
  useEffect(() => {
    const contextMenu: WebContextMenuLabels = {
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
    const tray: TrayLabels = {
      open: t('tray.open'),
      quit: t('tray.quit'),
    };
    const dialogs: DialogLabels = {
      saveAs: t('dialog.saveAs'),
      openWorkspace: t('dialog.openWorkspace'),
      addFolder: t('dialog.addFolder'),
      installPlugin: t('dialog.installPlugin'),
    };
    void window.marudesk.invoke('browser:set-context-menu-labels', contextMenu);
    void window.marudesk.invoke('app:set-tray-labels', tray);
    void window.marudesk.invoke('app:set-dialog-labels', dialogs);
    // `t` is stable per locale; re-run only when the locale changes.
  }, [t, locale]);
}
