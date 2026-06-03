import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          page: 'var(--surface-page)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
        },
        fg: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          disabled: 'var(--text-disabled)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          subtle: 'var(--accent-subtle)',
        },
        success: {
          DEFAULT: 'var(--success)',
          subtle: 'var(--success-subtle)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          subtle: 'var(--warning-subtle)',
        },
        error: {
          DEFAULT: 'var(--error)',
          subtle: 'var(--error-subtle)',
        },
        ai: {
          thinking: 'var(--ai-thinking)',
          grep: 'var(--ai-grep)',
          read: 'var(--ai-read)',
          edit: 'var(--ai-edit)',
        },
        diff: {
          add: 'var(--diff-add-bg)',
          remove: 'var(--diff-remove-bg)',
        },
      },
      borderColor: {
        subtle: 'var(--border-subtle)',
        DEFAULT: 'var(--border-default)',
        strong: 'var(--border-strong)',
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
  plugins: [],
};

export default config;
