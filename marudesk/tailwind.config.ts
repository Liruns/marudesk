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
      fontSize: {
        caption: ['12px', { lineHeight: '1.40', letterSpacing: '0.1px' }],
        'body-sm': ['13px', { lineHeight: '1.45' }],
        body: ['14px', { lineHeight: '1.55' }],
        title: ['18px', { lineHeight: '1.30', letterSpacing: '-0.1px' }],
        section: ['24px', { lineHeight: '1.20', letterSpacing: '-0.2px' }],
        hero: ['40px', { lineHeight: '1.12', letterSpacing: '-0.5px' }],
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
      boxShadow: {
        glow: '0 0 0 1px var(--border-default), 0 8px 24px rgba(0, 0, 0, 0.32)',
        lifted: '0 0 0 1px var(--border-default), 0 24px 56px rgba(0, 0, 0, 0.48)',
      },
    },
  },
  plugins: [],
};

export default config;
