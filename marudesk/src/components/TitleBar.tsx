import type { MouseEvent } from 'react';
import { ArrowDownCircle, Download } from 'lucide-react';
import { useI18n } from '../i18n/useI18n';
import { cn } from '../lib/cn';
import { WindowControls } from './WindowControls';
import { ProfileSwitcher } from '../features/workspaces/ProfileSwitcher';
import { useUpdateStatus } from '../hooks/useUpdateStatus';
import logoUrl from '../assets/logo-mark.png';

function UpdateIndicator() {
  const status = useUpdateStatus();
  const { t } = useI18n();

  if (
    status.kind === 'disabled' ||
    status.kind === 'idle' ||
    status.kind === 'checking' ||
    status.kind === 'not-available' ||
    status.kind === 'error'
  )
    return null;

  if (status.kind === 'downloading') {
    return (
      <div
        className="no-drag flex items-center gap-1 px-2 py-0.5 rounded-md text-caption text-fg-secondary animate-pulse"
        title={t('titleBar.update.downloading')}
      >
        <ArrowDownCircle size={14} className="text-accent" />
        <span>{status.percent}%</span>
      </div>
    );
  }

  if (status.kind === 'available') {
    return (
      <div
        className="no-drag flex items-center gap-1 px-2 py-0.5 rounded-md text-caption text-fg-secondary animate-pulse"
        title={t('titleBar.update.downloading')}
      >
        <ArrowDownCircle size={14} className="text-accent" />
      </div>
    );
  }

  // downloaded — ready to install
  const install = () => {
    if (window.confirm(t('titleBar.update.confirm'))) {
      void window.marudesk.invoke('app:quit-and-install');
    }
  };

  return (
    <button
      type="button"
      onClick={install}
      title={t('titleBar.update.ready')}
      className={cn(
        'no-drag inline-flex items-center gap-1 h-6 px-2 rounded-md',
        'text-caption font-medium text-fg-primary bg-accent',
        'hover:bg-accent-hover transition-colors duration-fast',
      )}
    >
      <Download size={12} />
      <span>{status.version}</span>
    </button>
  );
}

/**
 * Frameless-window chrome: a single horizontal strip at the very top. The
 * wrapper is the drag region (grab empty space to move the window); interactive
 * children opt out via `.no-drag`.
 *
 * Layout: [logo slot] [tabs ............] [window controls]
 *
 * The logo slot is a 48px column that lines up with the ActivityBar directly
 * below it (same width + a shared right border), so the top-left reads as one
 * continuous vertical rail instead of a floating brand block. On macOS the OS
 * draws the traffic lights top-left, so the slot shifts right to clear them and
 * the rail alignment is dropped there.
 */
export function TitleBar() {
  const { t } = useI18n();
  const isMac =
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Macintosh');

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('[role="tab"], button, input, [data-no-maximize]')) {
      return;
    }
    void window.marudesk.invoke('window:maximize-toggle');
  };

  return (
    <div
      className="drag-region h-10 shrink-0 flex items-stretch bg-surface-1 border-b border-subtle"
      role="banner"
      aria-label={t('titleBar.windowChrome')}
      onDoubleClick={onDoubleClick}
    >
      {isMac ? (
        <div
          className="flex items-center shrink-0"
          style={{ paddingLeft: 76, paddingRight: 12 }}
        >
          <img src={logoUrl} alt="" aria-hidden draggable={false} className="size-6 select-none" />
        </div>
      ) : (
        <div className="w-12 shrink-0 flex items-center justify-center border-r border-subtle">
          <img src={logoUrl} alt="" aria-hidden draggable={false} className="size-6 select-none" />
        </div>
      )}
      <div className="flex items-center gap-1.5 pl-2">
        <ProfileSwitcher />
        <UpdateIndicator />
      </div>
      <div className="drag-region flex-1 min-w-0" aria-hidden />
      <WindowControls />
    </div>
  );
}
