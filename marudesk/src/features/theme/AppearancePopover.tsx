import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ACCENTS, useThemeStore } from './store';
import { useSettingsStore } from '../settings/store';
import type { ThemeMode } from '../../../shared/settings';

const MODES: { value: ThemeMode; label: string; icon: typeof Monitor }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

/**
 * Small floating Appearance panel launched from the activity-bar gear: the app
 * accent (a [data-accent] swap) plus the light/dark/system color mode. Mode is
 * wired to the existing settings store (the single owner of data-theme + the
 * Monaco/terminal themes) so this never forks that state. A full-screen backdrop
 * captures the dismiss click; the panel anchors bottom-left, clear of the rail.
 */
export function AppearancePopover({ onClose }: { onClose: () => void }) {
  const accent = useThemeStore((s) => s.accent);
  const setAccent = useThemeStore((s) => s.setAccent);
  const mode = useSettingsStore((s) => s.settings.appearance.theme);
  const update = useSettingsStore((s) => s.update);

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Appearance"
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-8 left-14 w-60 rounded-lg border border-subtle bg-surface-2 p-3 shadow-lg shadow-black/40 flex flex-col gap-3"
      >
        {/* Accent */}
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
          <p className="text-caption text-fg-tertiary leading-relaxed">
            Re-skins the whole app — buttons, links, active states and focus rings.
          </p>
        </div>

        <div className="h-px bg-subtle" aria-hidden />

        {/* Color mode */}
        <div className="flex flex-col gap-1.5">
          <span className="text-caption uppercase tracking-wider text-fg-tertiary">
            Mode
          </span>
          <div className="flex items-center gap-1 rounded-md bg-surface-1 p-0.5">
            {MODES.map((m) => {
              const Icon = m.icon;
              const active = mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => void update({ appearance: { theme: m.value } })}
                  aria-pressed={active}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 h-7 rounded text-caption transition-colors duration-fast',
                    active
                      ? 'bg-surface-3 text-fg-primary'
                      : 'text-fg-tertiary hover:text-fg-secondary',
                  )}
                >
                  <Icon size={13} /> {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
