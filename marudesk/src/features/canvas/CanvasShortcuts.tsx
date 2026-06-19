import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/messages';

/**
 * A quiet, dismissible cheat-sheet of the canvas keymap (opened with `?`). The
 * infinite canvas has a lot of shortcuts (pan/zoom/fit/select/nudge/reveal) that
 * are otherwise invisible; this surfaces them without cluttering the chrome.
 * `mod` renders as ⌘ on macOS, Ctrl elsewhere.
 */
const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

type Row = { keys: string[]; label: TranslationKey };
const ROWS: readonly Row[] = [
  { keys: ['Space', '+', 'drag'], label: 'canvas.help.pan' },
  { keys: [mod, '+', 'scroll'], label: 'canvas.help.zoom' },
  { keys: ['+', '/', '−'], label: 'canvas.help.zoomKeys' },
  { keys: ['0'], label: 'canvas.help.resetZoom' },
  { keys: ['F'], label: 'canvas.help.fit' },
  { keys: ['⇧', '+', '2'], label: 'canvas.help.zoomSelection' },
  { keys: [mod, '+', 'A'], label: 'canvas.help.selectAll' },
  { keys: ['Delete'], label: 'canvas.help.delete' },
  { keys: ['↑', '↓', '←', '→'], label: 'canvas.help.nudge' },
  { keys: ['Double-click'], label: 'canvas.help.newCard' },
  { keys: [mod, '+', '⇧', '+', 'M'], label: 'canvas.help.minimap' },
  { keys: [mod, '+', '⇧', '+', 'A'], label: 'canvas.help.palette' },
];

export function CanvasShortcuts({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-[100001] grid place-items-center bg-surface-page/40"
      onPointerDown={onClose}
    >
      <div
        role="dialog"
        aria-label={t('canvas.help.title')}
        className="w-full max-w-md rounded-xl chrome-popover p-5 animate-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-body font-medium text-fg-primary">{t('canvas.help.title')}</h2>
          <button
            type="button"
            aria-label={t('canvas.help.close')}
            title={t('canvas.help.close')}
            onClick={onClose}
            className="chrome-icon-button size-7"
          >
            <X size={15} />
          </button>
        </div>
        <dl className="mt-3 flex flex-col gap-1.5">
          {ROWS.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-4">
              <dt className="text-body-sm text-fg-secondary">{t(r.label)}</dt>
              <dd className="flex shrink-0 items-center gap-1">
                {r.keys.map((k, i) =>
                  k === '+' || k === '/' ? (
                    <span key={i} aria-hidden className="text-caption text-fg-tertiary">
                      {k}
                    </span>
                  ) : (
                    <kbd
                      key={i}
                      className="rounded bg-surface-3 px-1.5 py-0.5 text-caption tabular-nums text-fg-secondary"
                    >
                      {k}
                    </kbd>
                  ),
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
