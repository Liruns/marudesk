import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ACCENTS, useThemeStore } from './store';

/**
 * The app-accent picker, shared by the gear Appearance popover (`grid`, on
 * surface-2) and the Settings → Appearance field (`row`, on surface-1). One
 * component so the swatch markup, a11y labels, and active-ring treatment can't
 * drift between the two places. The variant only governs layout/offset; the
 * swatch hexes come from the theme store (the single owner of accent presets).
 */
export function AccentSwatches({ variant }: { variant: 'grid' | 'row' }) {
  const accent = useThemeStore((s) => s.accent);
  const setAccent = useThemeStore((s) => s.setAccent);
  const grid = variant === 'grid';
  return (
    <div className={grid ? 'grid grid-cols-6 gap-1.5' : 'flex items-center gap-1.5'}>
      {ACCENTS.map((option) => {
        const active = option.name === accent;
        return (
          <button
            key={option.name}
            type="button"
            onClick={() => setAccent(option.name)}
            aria-label={option.label}
            aria-pressed={active}
            title={option.label}
            className={cn(
              'flex items-center justify-center transition-transform duration-fast hover:scale-110',
              grid ? 'aspect-square rounded-md' : 'size-6 rounded-full',
              active
                ? cn(
                    'ring-2 ring-fg-primary/80 ring-offset-2',
                    grid ? 'ring-offset-surface-2' : 'ring-offset-surface-1',
                  )
                : '',
            )}
            style={{ backgroundColor: option.swatch }}
          >
            {active ? <Check size={grid ? 13 : 12} className="text-white" /> : null}
          </button>
        );
      })}
    </div>
  );
}
