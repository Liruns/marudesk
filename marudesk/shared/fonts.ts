/**
 * Curated font presets + graceful fallback stacks for the user-overridable UI,
 * editor, and terminal fonts.
 *
 * A user can pick a preset from a dropdown or type any installed family name.
 * Either way {@link fontStack} appends the design-token default stack, so an
 * uninstalled or misspelled family degrades to a sane font instead of the
 * browser's default serif. The presets are families that ship with
 * Windows/macOS/Linux (or are bundled), so the dropdown always offers something
 * that actually renders on the user's machine.
 */

export type FontOption = { label: string; value: string };

/** Empty value = "use the default stack" (the bundled design font). */
export const DEFAULT_FONT_OPTION: FontOption = {
  label: 'System default',
  value: '',
};

/* Default fallback stacks — mirror src/styles/tokens.css --font-body / --font-mono,
 * with a couple of extra cross-platform families appended for robustness. */
export const UI_FONT_FALLBACK =
  "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const MONO_FONT_FALLBACK =
  "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export const UI_FONT_PRESETS: FontOption[] = [
  DEFAULT_FONT_OPTION,
  { label: 'Inter', value: 'Inter' },
  { label: 'System UI', value: 'system-ui' },
  { label: 'Segoe UI', value: 'Segoe UI' },
  { label: 'Roboto', value: 'Roboto' },
  { label: 'Helvetica Neue', value: 'Helvetica Neue' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Georgia (serif)', value: 'Georgia' },
];

export const MONO_FONT_PRESETS: FontOption[] = [
  DEFAULT_FONT_OPTION,
  { label: 'JetBrains Mono', value: 'JetBrains Mono' },
  { label: 'Cascadia Code', value: 'Cascadia Code' },
  { label: 'Cascadia Mono', value: 'Cascadia Mono' },
  { label: 'Consolas', value: 'Consolas' },
  { label: 'SF Mono', value: 'SF Mono' },
  { label: 'Menlo', value: 'Menlo' },
  { label: 'Fira Code', value: 'Fira Code' },
  { label: 'Source Code Pro', value: 'Source Code Pro' },
  { label: 'Courier New', value: 'Courier New' },
];

/** CSS-wide / generic family keywords that must NOT be quoted. */
const FONT_KEYWORDS = new Set([
  'system-ui',
  'ui-monospace',
  'ui-sans-serif',
  'ui-serif',
  'monospace',
  'sans-serif',
  'serif',
  'cursive',
  'fantasy',
  'inherit',
  'initial',
  'unset',
]);

/** Quote a family name that contains whitespace and isn't a CSS keyword. */
function quoteFamily(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (FONT_KEYWORDS.has(trimmed.toLowerCase())) return trimmed;
  // A value the user typed as a full stack / already-quoted — trust it as-is.
  if (/[",]/.test(trimmed)) return trimmed;
  return /\s/.test(trimmed) ? `'${trimmed}'` : trimmed;
}

/**
 * Build a CSS font-family value for a user-chosen font, always backed by the
 * appropriate default stack so an uninstalled family still renders. Empty input
 * returns the default stack alone.
 */
export function fontStack(userFont: string | undefined, kind: 'ui' | 'mono'): string {
  const fallback = kind === 'mono' ? MONO_FONT_FALLBACK : UI_FONT_FALLBACK;
  const family = quoteFamily(userFont ?? '');
  if (!family) return fallback;
  return `${family}, ${fallback}`;
}

/** Generic/keyword families that are always "available" (no install needed). */
export function isGenericFamily(family: string): boolean {
  return FONT_KEYWORDS.has(family.trim().toLowerCase());
}
