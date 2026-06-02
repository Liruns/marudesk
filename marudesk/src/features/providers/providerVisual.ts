import type { ProviderId } from '../../../shared/providers';

/**
 * Monogram fallback for brand-less providers — i.e. user-configured custom
 * OpenAI-compatible endpoints (`custom:<id>`), which have no logo. Built-in
 * providers now render a real brand mark in {@link ProviderGlyph}, so this is
 * only the custom-endpoint case: one letter from the human label, tinted with
 * the design-system accent.
 */

export type ProviderVisual = { mono: string; color: string };

const ACCENT = '#5E6AD2'; // design-system accent

/** Resolve a (brand-less) provider + optional label to its monogram + color. */
export function providerVisual(_provider: ProviderId, label?: string): ProviderVisual {
  const mono = (label?.trim()?.[0] ?? '◆').toUpperCase();
  return { mono, color: ACCENT };
}
