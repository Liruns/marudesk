import type { Config } from 'tailwindcss';
import containerQueries from '@tailwindcss/container-queries';

/**
 * Alpha-capable token color. The tokens are plain `var(--x)` colors, which
 * Tailwind 3 can't derive opacity modifiers from — as bare strings,
 * `bg-surface-1/70` would silently generate no CSS at all. A function color
 * keeps unmodified utilities on the bare var() while modifiers composite the
 * alpha via CSS `color-mix()` (always available: the renderer is Chromium).
 * Tailwind accepts function colors at runtime but its public types only model
 * strings, so the gap is confined to this helper's cast.
 */
function token(cssVar: string): string {
  const color = ({ opacityValue }: { opacityValue?: string }) =>
    // No modifier (or Tailwind's own `--tw-*-opacity` plumbing) → bare token.
    !opacityValue || opacityValue.startsWith('var(')
      ? `var(${cssVar})`
      : `color-mix(in srgb, var(${cssVar}) calc(${opacityValue} * 100%), transparent)`;
  return color as unknown as string;
}

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          page: token('--surface-page'),
          1: token('--surface-1'),
          2: token('--surface-2'),
          3: token('--surface-3'),
        },
        fg: {
          primary: token('--text-primary'),
          secondary: token('--text-secondary'),
          tertiary: token('--text-tertiary'),
          disabled: token('--text-disabled'),
        },
        accent: {
          DEFAULT: token('--accent'),
          hover: token('--accent-hover'),
          subtle: token('--accent-subtle'),
        },
        success: {
          DEFAULT: token('--success'),
          subtle: token('--success-subtle'),
        },
        warning: {
          DEFAULT: token('--warning'),
          subtle: token('--warning-subtle'),
        },
        error: {
          DEFAULT: token('--error'),
          subtle: token('--error-subtle'),
        },
        ai: {
          thinking: token('--ai-thinking'),
          grep: token('--ai-grep'),
          read: token('--ai-read'),
          edit: token('--ai-edit'),
        },
        diff: {
          add: token('--diff-add-bg'),
          remove: token('--diff-remove-bg'),
        },
        // DevTools box-model diagram region fills (Elements › Computed).
        boxmodel: {
          margin: token('--boxmodel-margin'),
          border: token('--boxmodel-border'),
          padding: token('--boxmodel-padding'),
          content: token('--boxmodel-content'),
        },
      },
      borderColor: {
        subtle: token('--border-subtle'),
        DEFAULT: token('--border-default'),
        strong: token('--border-strong'),
      },
      // Hairline fills (`bg-subtle`) — dividers and resting indicator dots ride
      // the same token as the subtle border so they read as one hairline system.
      backgroundColor: {
        subtle: token('--border-subtle'),
      },
      fontFamily: {
        display: 'var(--font-display)',
        body: 'var(--font-body)',
        mono: 'var(--font-mono)',
      },
      // rem-based so "Interface zoom" (the root font-size set by the settings
      // store) scales the whole type ramp. Values equal the prior px at the
      // 16px baseline, so 100% zoom is pixel-identical to before.
      fontSize: {
        caption: ['0.75rem', { lineHeight: '1.40', letterSpacing: '0.2px' }],
        'body-sm': ['0.8125rem', { lineHeight: '1.45', letterSpacing: '0.1px' }],
        body: ['0.875rem', { lineHeight: '1.55' }],
        title: ['1.125rem', { lineHeight: '1.30', letterSpacing: '-0.1px' }],
        section: ['1.5rem', { lineHeight: '1.20', letterSpacing: '-0.2px' }],
        hero: ['2.5rem', { lineHeight: '1.12', letterSpacing: '-0.5px' }],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
        pill: 'var(--radius-pill)',
      },
      transitionDuration: {
        instant: '0ms',
        fast: '120ms',
        standard: '200ms',
      },
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(0.2, 0, 0, 1)',
      },
      // Entrance motion only — short, single-easing (§9), no overshoot. Both ride
      // the motion tokens so a global easing/duration change flows through. The
      // reduced-motion block in index.css collapses these to a near-instant snap.
      keyframes: {
        'fade-rise': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'translateY(4px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        // `both` holds the 0% (hidden) state through any stagger delay.
        'fade-rise': 'fade-rise var(--motion-standard) var(--easing) both',
        'scale-in': 'scale-in var(--motion-standard) var(--easing)',
        // Model-state Spinner: a calm 1.2s linear sweep (§4 Spinner), slower than
        // Tailwind's default 1s so the four AI-timeline arcs read as unhurried.
        'spin-ai': 'spin 1.2s linear infinite',
      },
      boxShadow: {
        glow: '0 0 0 1px var(--border-default), 0 8px 24px rgba(0, 0, 0, 0.32)',
        lifted: '0 0 0 1px var(--border-default), 0 24px 56px rgba(0, 0, 0, 0.48)',
        // Depth language (§6): inset top-edge highlight, elevated card, carved-in
        // inset. Layer beneath borders — they don't replace the hairline.
        highlight: 'var(--highlight)',
        card: 'var(--elevate-card)',
        'inset-soft': 'var(--inset-shadow)',
        // Soft accent halo for the primary input's focus state (rides --accent).
        'focus-accent': 'var(--focus-glow)',
        // Floating menu/popover — richer lift than card, used by ContextMenu.
        menu: 'var(--shadow-menu)',
      },
      backgroundImage: {
        // Featured-surface gradient + page vignette — layered over a surface
        // fill, which still owns the base color.
        'surface-gradient': 'var(--surface-gradient)',
        vignette: 'var(--page-vignette)',
        // Chromatic brand bloom behind hero marks — the one allowed accent glow.
        'accent-glow': 'var(--accent-glow)',
      },
    },
  },
  // Container queries (@container / @[64rem]:*) — surfaces that live inside a
  // split pane (the AI Chat tab) must adapt to their PANE's width, not the
  // viewport's; vw-keyed breakpoints never reflow on a divider drag.
  plugins: [containerQueries],
};

export default config;
