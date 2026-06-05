import { History, MoreVertical } from 'lucide-react';
import type { BrowserNativeMenuItem } from '../../../shared/browser';
import type { HistoryEntry } from '../../../shared/history';
import { toast } from '../../lib/toast';
import { toMessage } from '../../lib/toMessage';
import { useDownloadsStore } from './downloads';
import { useBrowserStrings } from './browserStrings';
import { useWebPageStore } from './store';
import { useDevtoolsStore } from '../devtools/store';
import { openSettingsTab } from '../settings/store';
import { useTabsStore } from '../tabs/store';

const HISTORY_ACTION_PREFIX = 'history:';

function separator(): BrowserNativeMenuItem {
  return { type: 'separator' };
}

function historyLabel(entry: HistoryEntry): string {
  return entry.title || entry.url.replace(/^https?:\/\//i, '');
}

async function recentHistory(): Promise<HistoryEntry[]> {
  try {
    return await window.marudesk.invoke('history:recent');
  } catch {
    return [];
  }
}

async function popupMenu(
  button: HTMLButtonElement,
  items: readonly BrowserNativeMenuItem[],
): Promise<string | null> {
  const rect = button.getBoundingClientRect();
  return window.marudesk.invoke('browser:popup-menu', {
    x: rect.right,
    y: rect.bottom + 6,
    items: [...items],
  });
}

function historyEntryFromAction(
  action: string,
  recent: readonly HistoryEntry[],
): HistoryEntry | undefined {
  if (!action.startsWith(HISTORY_ACTION_PREFIX)) return undefined;
  const index = Number(action.slice(HISTORY_ACTION_PREFIX.length));
  return Number.isInteger(index) ? recent[index] : undefined;
}

function nativeMenuButtonClass(): string {
  return [
    'size-8 rounded-pill flex items-center justify-center shrink-0',
    'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
    'transition-colors duration-fast',
  ].join(' ');
}

export function BrowserMenu() {
  const { t } = useBrowserStrings();
  const currentUrl = useWebPageStore((s) => s.currentUrl);
  const nav = useTabsStore((s) => s.nav);
  const downloadCount = useDownloadsStore((s) => s.downloads.length);

  const hasUrl = currentUrl.length > 0 || nav.url.length > 0;
  const url = currentUrl || nav.url;
  const zoomPct = Math.round(nav.zoomFactor * 100);

  const copyUrl = async (): Promise<void> => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: t('browser.menu.toast.urlCopied'), description: url, variant: 'success' });
    } catch (err) {
      toast({ title: t('browser.menu.toast.copyFailed'), description: toMessage(err), variant: 'error' });
    }
  };

  const screenshot = async (): Promise<void> => {
    try {
      const ok = await window.marudesk.invoke('browser:capture-page');
      toast(
        ok
          ? { title: t('browser.menu.toast.screenshotCopied'), variant: 'success' }
          : { title: t('browser.menu.toast.nothingToCapture'), variant: 'error' },
      );
    } catch (err) {
      toast({ title: t('browser.menu.toast.screenshotFailed'), description: toMessage(err), variant: 'error' });
    }
  };

  const buildItems = (recent: readonly HistoryEntry[]): BrowserNativeMenuItem[] => [
    { id: 'find', label: t('browser.menu.find'), shortcut: 'Ctrl+F' },
    { id: 'zoom-in', label: t('browser.menu.zoomIn'), shortcut: 'Ctrl++' },
    { id: 'zoom-out', label: t('browser.menu.zoomOut'), shortcut: 'Ctrl+-' },
    {
      id: 'zoom-reset',
      label: `${t('browser.menu.resetZoom')} (${zoomPct}%)`,
      shortcut: 'Ctrl+0',
      enabled: zoomPct !== 100,
    },
    separator(),
    { id: 'reload', label: t('browser.menu.reload'), shortcut: 'Ctrl+R', enabled: hasUrl },
    {
      id: 'hard-reload',
      label: t('browser.menu.hardReload'),
      shortcut: 'Ctrl+Shift+R',
      enabled: hasUrl,
    },
    ...(nav.isLoading
      ? [{ id: 'stop', label: t('browser.menu.stop'), shortcut: 'Esc' }]
      : []),
    separator(),
    {
      id: 'downloads',
      label: t('browser.menu.downloads'),
      shortcut: 'Ctrl+J',
      enabled: downloadCount > 0,
    },
    { id: 'copy-url', label: t('browser.menu.copyUrl'), enabled: !!url },
    { id: 'copy-screenshot', label: t('browser.menu.copyScreenshot'), enabled: hasUrl },
    ...(nav.audible || nav.audioMuted
      ? [
          {
            id: 'toggle-audio',
            label: t(nav.audioMuted ? 'browser.audio.unmute' : 'browser.audio.mute'),
          },
        ]
      : []),
    { id: 'duplicate-tab', label: t('browser.menu.duplicateTab'), enabled: !!url },
    { id: 'open-devtools', label: t('browser.menu.openDevtools'), shortcut: 'F12' },
    ...(recent.length > 0
      ? [
          separator(),
          ...recent.slice(0, 6).map((entry, index) => ({
            id: `${HISTORY_ACTION_PREFIX}${index}`,
            label: historyLabel(entry),
          })),
        ]
      : []),
    separator(),
    { id: 'settings', label: t('browser.menu.settings') },
  ];

  const handleAction = (action: string, recent: readonly HistoryEntry[]): void => {
    const historyEntry = historyEntryFromAction(action, recent);
    if (historyEntry) {
      void window.marudesk.invoke('browser:navigate', historyEntry.url);
      return;
    }
    switch (action) {
      case 'find':
        useWebPageStore.getState().openFind();
        return;
      case 'zoom-in':
        void useTabsStore.getState().zoom('in');
        return;
      case 'zoom-out':
        void useTabsStore.getState().zoom('out');
        return;
      case 'zoom-reset':
        void useTabsStore.getState().zoom('reset');
        return;
      case 'reload':
        void useTabsStore.getState().reload();
        return;
      case 'hard-reload':
        void useTabsStore.getState().reload(true);
        return;
      case 'stop':
        void useTabsStore.getState().reloadOrStop();
        return;
      case 'downloads':
        useDownloadsStore.getState().openShelf();
        return;
      case 'copy-url':
        void copyUrl();
        return;
      case 'copy-screenshot':
        void screenshot();
        return;
      case 'toggle-audio':
        void window.marudesk.invoke('browser:set-audio-muted', !nav.audioMuted);
        return;
      case 'duplicate-tab':
        void useTabsStore.getState().newTab('web', url);
        return;
      case 'open-devtools':
        useDevtoolsStore.getState().toggle();
        return;
      case 'settings':
        void openSettingsTab('browser');
        return;
      default:
        return;
    }
  };

  const openMenu = async (button: HTMLButtonElement): Promise<void> => {
    const recent = await recentHistory();
    const selected = await popupMenu(button, buildItems(recent));
    if (selected) handleAction(selected, recent);
  };

  return (
    <button
      type="button"
      aria-label={t('browser.menu.button')}
      title={t('browser.menu.button')}
      aria-haspopup="menu"
      onClick={(event) => void openMenu(event.currentTarget)}
      className={nativeMenuButtonClass()}
    >
      <MoreVertical size={16} />
    </button>
  );
}

export function BrowserHistoryMenu() {
  const { t } = useBrowserStrings();

  const openMenu = async (button: HTMLButtonElement): Promise<void> => {
    const recent = await recentHistory();
    const items: BrowserNativeMenuItem[] =
      recent.length > 0
        ? recent.slice(0, 12).map((entry, index) => ({
            id: `${HISTORY_ACTION_PREFIX}${index}`,
            label: historyLabel(entry),
          }))
        : [{ id: 'empty', label: t('context.drawer.history'), enabled: false }];
    const selected = await popupMenu(button, items);
    if (!selected) return;
    const entry = historyEntryFromAction(selected, recent);
    if (entry) void window.marudesk.invoke('browser:navigate', entry.url);
  };

  return (
    <button
      type="button"
      aria-label={t('context.drawer.history')}
      title={t('context.drawer.history')}
      aria-haspopup="menu"
      onClick={(event) => void openMenu(event.currentTarget)}
      className={nativeMenuButtonClass()}
    >
      <History size={16} />
    </button>
  );
}
