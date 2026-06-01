import type { ProviderId } from '../../../shared/providers';
import { providerVisual } from './providerVisual';

/**
 * Provider brand identity for the model picker / chip. lucide dropped real brand
 * logos, so we render a tasteful **monogram chip** instead: the provider's letter
 * in its brand color over a low-alpha tint of the same hue with a hairline ring.
 * This is what gives the otherwise-generic picker a per-provider "personality"
 * (the v5 design's fix for the picker reading as 촌스러운/dated) — the model label
 * stays the real identifier, the glyph is brand flavor for fast scanning.
 *
 * Colors are arbitrary brand hexes (not in the Tailwind token set), so they're
 * applied inline; everything else stays on the design-system classes. The
 * id→glyph mapping lives in ./providerVisual so this file only exports a
 * component (renderer fast-refresh rule).
 */
export function ProviderGlyph({
  provider,
  label,
  size = 18,
  className,
}: {
  provider: ProviderId;
  label?: string;
  size?: number;
  className?: string;
}) {
  const v = providerVisual(provider, label);
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-semibold leading-none ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.52),
        color: v.color,
        backgroundColor: `${v.color}1f`, // ~12% alpha tint of the brand hue
        boxShadow: `inset 0 0 0 1px ${v.color}33`, // ~20% alpha hairline ring
      }}
    >
      {v.mono}
    </span>
  );
}
