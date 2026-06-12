import type { TabGroupColor } from '../../../shared/browser';

/**
 * Static Tailwind class strings per tab-group hue. Spelled out literally (not
 * template-built) so the content scanner sees every class; all of them ride the
 * `--tabgroup-*` tokens via the tailwind.config.ts `tabgroup` color family —
 * no hex ever appears in component code (DESIGN.md rule).
 */
export type GroupColorClasses = {
  /** The group chip pill: tinted fill + colored text. */
  readonly chip: string;
  /** The 1.5px tie bar on member tab chips (matches the chip's hue). */
  readonly bar: string;
  /** Solid dot (unnamed-group chip face, menu glyphs). */
  readonly dot: string;
  /** Solid swatch button in the color picker row. */
  readonly swatch: string;
};

export const GROUP_COLOR_CLASSES: Readonly<
  Record<TabGroupColor, GroupColorClasses>
> = {
  violet: {
    chip: 'bg-tabgroup-violet/15 text-tabgroup-violet',
    bar: 'bg-tabgroup-violet/80',
    dot: 'bg-tabgroup-violet',
    swatch: 'bg-tabgroup-violet',
  },
  blue: {
    chip: 'bg-tabgroup-blue/15 text-tabgroup-blue',
    bar: 'bg-tabgroup-blue/80',
    dot: 'bg-tabgroup-blue',
    swatch: 'bg-tabgroup-blue',
  },
  teal: {
    chip: 'bg-tabgroup-teal/15 text-tabgroup-teal',
    bar: 'bg-tabgroup-teal/80',
    dot: 'bg-tabgroup-teal',
    swatch: 'bg-tabgroup-teal',
  },
  green: {
    chip: 'bg-tabgroup-green/15 text-tabgroup-green',
    bar: 'bg-tabgroup-green/80',
    dot: 'bg-tabgroup-green',
    swatch: 'bg-tabgroup-green',
  },
  amber: {
    chip: 'bg-tabgroup-amber/15 text-tabgroup-amber',
    bar: 'bg-tabgroup-amber/80',
    dot: 'bg-tabgroup-amber',
    swatch: 'bg-tabgroup-amber',
  },
  rose: {
    chip: 'bg-tabgroup-rose/15 text-tabgroup-rose',
    bar: 'bg-tabgroup-rose/80',
    dot: 'bg-tabgroup-rose',
    swatch: 'bg-tabgroup-rose',
  },
};
