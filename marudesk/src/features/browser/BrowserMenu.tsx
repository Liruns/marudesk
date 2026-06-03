import { useState } from 'react';
import {
  Camera,
  Copy,
  CopyPlus,
  Download,
  MoreVertical,
  RotateCw,
  Search,
  Settings,
  Volume2,
  VolumeX,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { ContextMenu, type MenuItem } from '../../components/ContextMenu';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { toMessage } from '../../lib/toMessage';
import type { HistoryEntry } from '../../../shared/history';
import { useWebPageStore } from './store';
import { useDownloadsStore } from './downloads';
import { useTabsStore } from '../tabs/store';
import { useDevtoolsStore } from '../devtools/store';
import { openSettingsTab } from '../settings/store';

/**
 * Browser overflow (⋮) menu — Chrome/Arc-style page-action menu for the embedded
 * browser tab. Page- and dev-scoped actions only (the IDE shell owns window /
 * profile / theme concerns); each item maps to an already-built renderer
 * capability. Lives in the React toolbar (not over the stage) because the native
 * WebContentsView composites above React, so a stage popover would be occluded —
 * the same constraint that keeps the find bar in the chrome.
 *
 * Items whose precondition isn't met (no current URL → Copy URL / Duplicate tab)
 * are disabled rather than shown as dead actions. Stop only appears while a load
 * is in flight. View-page-source / Print / History are intentionally omitted —
 * they'd need new IPC/security work this pass avoids.
 */
export function BrowserMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const currentUrl = useWebPageStore((s) => s.currentUrl);
  const nav = useTabsStore((s) => s.nav);
  const downloadCount = useDownloadsStore((s) => s.downloads.length);

  const hasUrl = currentUrl.length > 0 || nav.url.length > 0;
  const url = currentUrl || nav.url;
  const zoomPct = Math.round(nav.zoomFactor * 100);

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'URL copied', description: url, variant: 'success' });
    } catch (err) {
      toast({ title: 'Copy failed', description: toMessage(err), variant: 'error' });
    }
  };

  const screenshot = async () => {
    try {
      const ok = await window.marudesk.invoke('browser:capture-page');
      toast(
        ok
          ? { title: 'Screenshot copied to clipboard', variant: 'success' }
          : { title: 'Nothing to capture', variant: 'error' },
      );
    } catch (err) {
      toast({ title: 'Screenshot failed', description: toMessage(err), variant: 'error' });
    }
  };

  const items: MenuItem[] = [
    {
      label: 'Find in page',
      icon: <Search size={15} />,
      shortcut: 'Ctrl+F',
      onSelect: () => useWebPageStore.getState().openFind(),
    },
    {
      label: 'Zoom in',
      icon: <ZoomIn size={15} />,
      shortcut: 'Ctrl++',
      onSelect: () => void useTabsStore.getState().zoom('in'),
    },
    {
      label: 'Zoom out',
      icon: <ZoomOut size={15} />,
      shortcut: 'Ctrl+-',
      onSelect: () => void useTabsStore.getState().zoom('out'),
    },
    {
      label: `Reset zoom (${zoomPct}%)`,
      shortcut: 'Ctrl+0',
      disabled: zoomPct === 100,
      onSelect: () => void useTabsStore.getState().zoom('reset'),
    },
    { type: 'separator' },
    {
      label: 'Reload',
      icon: <RotateCw size={15} />,
      shortcut: 'Ctrl+R',
      disabled: !hasUrl,
      onSelect: () => void useTabsStore.getState().reload(),
    },
    {
      label: 'Hard reload (clear cache)',
      shortcut: 'Ctrl+Shift+R',
      disabled: !hasUrl,
      onSelect: () => void useTabsStore.getState().reload(true),
    },
    ...(nav.isLoading
      ? [
          {
            label: 'Stop',
            icon: <X size={15} />,
            shortcut: 'Esc',
            onSelect: () => void useTabsStore.getState().reloadOrStop(),
          } satisfies MenuItem,
        ]
      : []),
    { type: 'separator' },
    {
      label: 'Downloads',
      icon: <Download size={15} />,
      shortcut: 'Ctrl+J',
      disabled: downloadCount === 0,
      onSelect: () => useDownloadsStore.getState().openShelf(),
    },
    {
      label: 'Copy current URL',
      icon: <Copy size={15} />,
      disabled: !url,
      onSelect: () => void copyUrl(),
    },
    {
      label: 'Copy screenshot',
      icon: <Camera size={15} />,
      disabled: !hasUrl,
      onSelect: () => void screenshot(),
    },
    ...(nav.audible || nav.audioMuted
      ? [
          {
            label: nav.audioMuted ? 'Unmute tab' : 'Mute tab',
            icon: nav.audioMuted ? <Volume2 size={15} /> : <VolumeX size={15} />,
            onSelect: () =>
              void window.marudesk.invoke('browser:set-audio-muted', !nav.audioMuted),
          } satisfies MenuItem,
        ]
      : []),
    {
      label: 'Duplicate tab',
      icon: <CopyPlus size={15} />,
      disabled: !url,
      onSelect: () => void useTabsStore.getState().newTab('web', url),
    },
    {
      label: 'Open DevTools',
      icon: <Wrench size={15} />,
      shortcut: 'F12',
      onSelect: () => useDevtoolsStore.getState().toggle(),
    },
    ...(recent.length > 0
      ? [
          { type: 'separator' } satisfies MenuItem,
          ...recent.slice(0, 6).map(
            (e): MenuItem => ({
              label: e.title || e.url.replace(/^https?:\/\//i, ''),
              onSelect: () => void window.marudesk.invoke('browser:navigate', e.url),
            }),
          ),
        ]
      : []),
    { type: 'separator' },
    {
      label: 'Browser settings…',
      icon: <Settings size={15} />,
      onSelect: () => void openSettingsTab('browser'),
    },
  ];

  return (
    <>
      <button
        type="button"
        aria-label="Browser menu"
        title="Browser menu"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(e) => {
          // Set unconditionally (matching the ActivityBar menu): when the menu
          // is already open, the ContextMenu's outside-pointerdown dismissal has
          // already fired by the time this click runs, so a re-click closes it.
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.right, y: r.bottom + 6 });
          // Refresh the "recently visited" tail each time the menu opens.
          void window.marudesk
            .invoke('history:recent')
            .then(setRecent)
            .catch(() => undefined);
        }}
        className={cn(
          'size-8 rounded-pill flex items-center justify-center shrink-0 transition-colors duration-fast',
          menu
            ? 'text-accent bg-accent-subtle/40 hover:bg-accent-subtle/60'
            : 'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
        )}
      >
        <MoreVertical size={16} />
      </button>
      {menu ? (
        // Anchor by the button's right edge: the menu clamps left into the
        // viewport (ContextMenu does this), so it hangs left from the toolbar's
        // right side like Chrome's ⋮.
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}
