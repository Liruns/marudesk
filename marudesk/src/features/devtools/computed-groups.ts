/**
 * Grouping for the Elements panel's Computed tab: buckets a computed CSS
 * property name into one of four coarse categories (layout / text / appearance
 * / other) so the ~350-property list reads in sections instead of one flat
 * alphabet. Pure string classification — no React, no store.
 */

export const COMPUTED_GROUP_ORDER = ['layout', 'text', 'appearance', 'other'] as const;
export type ComputedGroupId = (typeof COMPUTED_GROUP_ORDER)[number];

const LAYOUT_PREFIXES = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'float',
  'clear',
  'z-index',
  'box-sizing',
  'width',
  'height',
  'min-',
  'max-',
  'margin',
  'padding',
  'flex',
  'grid',
  'gap',
  'row-gap',
  'column-gap',
  'align-',
  'justify-',
  'place-',
  'order',
  'overflow',
  'object-',
  'aspect-ratio',
  'contain',
];

const TEXT_PREFIXES = [
  'font',
  'text-',
  'line-height',
  'line-break',
  'letter-spacing',
  'word-',
  'white-space',
  'color',
  'direction',
  'writing-mode',
  'vertical-align',
  'tab-size',
  'hyphens',
  'quotes',
  'caret-color',
  '-webkit-text',
  '-webkit-font',
];

const APPEARANCE_PREFIXES = [
  'background',
  'border',
  'outline',
  'box-shadow',
  'opacity',
  'visibility',
  'filter',
  'backdrop-filter',
  'transform',
  'transition',
  'animation',
  'cursor',
  'clip',
  'mask',
  'mix-blend-mode',
  'accent-color',
  'appearance',
  'list-style',
  'scrollbar-',
];

function matches(name: string, prefixes: string[]): boolean {
  return prefixes.some((p) => name.startsWith(p));
}

export function computedGroup(name: string): ComputedGroupId {
  if (matches(name, LAYOUT_PREFIXES)) return 'layout';
  if (matches(name, TEXT_PREFIXES)) return 'text';
  if (matches(name, APPEARANCE_PREFIXES)) return 'appearance';
  return 'other';
}
