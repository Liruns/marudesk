import { useEffect, useState, type ReactNode } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { useI18n } from '../i18n/useI18n';
import { cn } from '../lib/cn';

/**
 * Custom title-bar window controls. Used in a frameless BrowserWindow so the
 * renderer paints its own min/maximize/close affordances (Discord/VSCode style)
 * instead of relying on the OS chrome.
 *
 * On macOS the OS still draws the traffic-light buttons because we use
 * titleBarStyle:'hiddenInset' — this component renders nothing there to avoid
 * doubling up.
 */
export function WindowControls() {
  const { t } = useI18n();
  const [isMaximized, setIsMaximized] = useState(false);
  // userAgent is stable for the window's lifetime — derive it during render
  // rather than syncing it into state from an effect.
  const isMac = navigator.userAgent.includes('Macintosh');

  useEffect(() => {
    void window.marudesk
      .invoke('window:is-maximized')
      .then((v) => setIsMaximized(!!v))
      .catch(() => undefined);
    const off = window.marudesk.on('window:maximize-state', (next) => {
      setIsMaximized(!!next);
    });
    return () => off();
  }, []);

  if (isMac) return null;

  return (
    <div
      className="flex items-stretch h-full no-drag shrink-0"
      role="group"
      aria-label={t('windowControls.group')}
    >
      <ControlButton
        label={t('windowControls.minimize')}
        onClick={() => void window.marudesk.invoke('window:minimize')}
      >
        <Minus size={14} strokeWidth={1.5} />
      </ControlButton>
      <ControlButton
        label={
          isMaximized
            ? t('windowControls.restore')
            : t('windowControls.maximize')
        }
        onClick={() => void window.marudesk.invoke('window:maximize-toggle')}
      >
        {isMaximized ? (
          <Copy size={12} strokeWidth={1.5} />
        ) : (
          <Square size={11} strokeWidth={1.5} />
        )}
      </ControlButton>
      <ControlButton
        label={t('windowControls.close')}
        danger
        onClick={() => void window.marudesk.invoke('window:close')}
      >
        <X size={14} strokeWidth={1.5} />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'w-11 h-full flex items-center justify-center shrink-0',
        'text-fg-secondary transition-colors duration-fast',
        danger
          ? 'hover:bg-error hover:text-white'
          : 'hover:bg-surface-2 hover:text-fg-primary',
      )}
    >
      {children}
    </button>
  );
}
