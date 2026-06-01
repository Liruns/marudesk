import type { ProviderId } from '../../../shared/providers';

/**
 * Provider brand identity for the model picker / chip (data only — the
 * {@link ProviderGlyph} component lives in its own file so the renderer's
 * fast-refresh rule is happy). lucide dropped real brand logos, so we render a
 * monogram in the provider's brand color; this maps each provider to that
 * letter + hue. The model label stays the real identifier; the glyph is flavor.
 */

export type ProviderVisual = { mono: string; color: string };

const VISUALS: Record<string, ProviderVisual> = {
  anthropic: { mono: 'A', color: '#D97757' }, // Anthropic coral
  openai: { mono: 'O', color: '#10A37F' }, // OpenAI teal-green
  'openai-codex': { mono: 'C', color: '#10A37F' }, // ChatGPT / Codex (same family)
  google: { mono: 'G', color: '#4285F4' }, // Google blue
  'google-caa': { mono: 'G', color: '#4285F4' },
  xai: { mono: 'x', color: '#B7BCC4' }, // xAI — black/white brand → light slate on dark
  ollama: { mono: 'O', color: '#A78BFA' }, // local — violet
};

const ACCENT = '#5E6AD2'; // design-system accent, for custom endpoints + fallback

/** Resolve a provider id (+ optional label for custom endpoints) to its glyph. */
export function providerVisual(provider: ProviderId, label?: string): ProviderVisual {
  const known = VISUALS[provider];
  if (known) return known;
  // custom:<id> — derive a monogram from the human label, tint with the accent.
  const mono = (label?.trim()?.[0] ?? '◆').toUpperCase();
  return { mono, color: ACCENT };
}
