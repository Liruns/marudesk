import { cn } from '../../lib/cn';
import { PALETTES } from './store';
import { useSettingsStore } from '../settings/store';

/**
 * The theme-palette picker, shared by the gear Appearance popover (`grid`, on
 * surface-2) and Settings → Appearance (`row`, on surface-1) — mirrors
 * AccentSwatches so the two pickers read as one family. Each chip previews a
 * palette's page+card surfaces; the active chip is marked by the ring alone
 * (a check glyph can't hold contrast across both dark and light chips). The
 * choice persists through the settings store, the single owner of
 * [data-palette].
 */
export function PaletteSwatches({ variant }: { variant: 'grid' | 'row' }) {
  const palette = useSettingsStore((s) => s.settings.appearance.palette);
  const update = useSettingsStore((s) => s.update);
  const grid = variant === 'grid';
  return (
    <div className={grid ? 'grid grid-cols-7 gap-1.5' : 'flex items-center gap-1.5'}>
      {PALETTES.map((option) => {
        const active = option.name === palette;
        return (
          <button
            key={option.name}
            type="button"
            onClick={() => void update({ appearance: { palette: option.name } })}
            aria-label={option.label}
            aria-pressed={active}
            title={option.label}
            className={cn(
              'border border-default transition-transform duration-fast hover:scale-105',
              grid ? 'aspect-square rounded-md' : 'h-6 w-9 rounded-md',
              active
                ? cn(
                    'ring-2 ring-fg-primary/80 ring-offset-2',
                    grid ? 'ring-offset-surface-2' : 'ring-offset-surface-1',
                  )
                : '',
            )}
            style={{ background: `linear-gradient(135deg, ${option.page} 50%, ${option.card} 50%)` }}
          />
        );
      })}
    </div>
  );
}
