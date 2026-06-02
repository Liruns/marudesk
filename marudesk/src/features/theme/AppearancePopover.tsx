import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ACCENTS, useThemeStore } from './store';

/**
 * Small floating Appearance panel (accent picker) launched from the activity-bar
 * gear. A full-screen backdrop captures the dismiss click; the panel anchors to
 * the bottom-left, clear of the 48px rail and the status bar.
 */
export function AppearancePopover({ onClose }: { onClose: () => void }) {
  const accent = useThemeStore((s) => s.accent);
  const setAccent = useThemeStore((s) => s.setAccent);

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Appearance"
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-8 left-14 w-56 rounded-lg border border-subtle bg-surface-2 p-3 shadow-lg shadow-black/40 flex flex-col gap-2.5"
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-caption uppercase tracking-wider text-fg-tertiary">
            Accent
          </span>
          <div className="grid grid-cols-6 gap-1.5">
            {ACCENTS.map((a) => {
              const active = a.name === accent;
              return (
                <button
                  key={a.name}
                  type="button"
                  onClick={() => setAccent(a.name)}
                  aria-label={a.label}
                  aria-pressed={active}
                  title={a.label}
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-md transition-transform duration-fast hover:scale-110',
                    active
                      ? 'ring-2 ring-fg-primary/80 ring-offset-2 ring-offset-surface-2'
                      : '',
                  )}
                  style={{ backgroundColor: a.swatch }}
                >
                  {active ? <Check size={13} className="text-white" /> : null}
                </button>
              );
            })}
          </div>
        </div>
        <p className="text-caption text-fg-tertiary leading-relaxed">
          Re-skins the whole app — buttons, links, active states and focus rings.
        </p>
      </div>
    </div>
  );
}
