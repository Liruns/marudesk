import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  UI_ZOOM_BASE_PX,
  type AppSettings,
  type SettingsPatch,
  type ThemeMode,
} from '../../../shared/settings';
import { fontStack } from '../../../shared/fonts';
import { applyHljsTheme } from '../../lib/hljsTheme';
import { openInstrument } from '../work-graph/instrument';

export type { SettingsPatch };

/** The Settings surface is split into VSCode-style categories (left nav). */
export type SettingsCategory =
  | 'appearance'
  | 'editor'
  | 'terminal'
  | 'application'
  | 'providers'
  | 'agent'
  | 'mcp'
  | 'plugins'
  | 'automations'
  | 'data'
  | 'usage'
  | 'about';

type SettingsState = {
  settings: AppSettings;
  loaded: boolean;
  /** Which category the Settings tab currently shows. */
  category: SettingsCategory;
};

type SettingsActions = {
  /** Load persisted settings, apply them, and wire live/system listeners. */
  init: () => Promise<void>;
  /** Persist a partial change (and apply optimistically). */
  update: (patch: SettingsPatch) => Promise<void>;
  reset: () => Promise<void>;
  setCategory: (category: SettingsCategory) => void;
};

/** Resolve 'system' against the OS preference; 'dark'/'light' pass through. */
export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }
  return mode;
}

/**
 * The single place settings touch the DOM: theme (data-theme), Interface zoom
 * (root font-size, which the rem type scale keys off), and the UI font override.
 * Editor/terminal fonts are applied by their own surfaces, not here.
 */
function applyAppearance(s: AppSettings): void {
  const root = document.documentElement;
  const theme = resolveTheme(s.appearance.theme);
  root.dataset.theme = theme;
  // Code-block token palette follows the app theme (github vs github-dark).
  applyHljsTheme(theme);
  // Surface palette (tokens.css [data-palette] blocks); 'default' clears the
  // attribute so the base graphite tokens apply.
  if (s.appearance.palette === 'default') delete root.dataset.palette;
  else root.dataset.palette = s.appearance.palette;
  // Cache mode + palette for the pre-paint guard in index.html (kills theme
  // FOUC on next launch). This only governs marudesk's own chrome — embedded
  // web views render in a separate partition and are intentionally unaffected.
  try {
    localStorage.setItem('marudesk.theme', s.appearance.theme);
    localStorage.setItem('marudesk.theme.palette', s.appearance.palette);
  } catch {
    // localStorage may be unavailable; the guard is best-effort.
  }
  root.style.fontSize = `${(UI_ZOOM_BASE_PX * s.appearance.uiZoom) / 100}px`;
  const ui = s.appearance.uiFontFamily.trim();
  if (ui) {
    // Always back the user's font with the default stack so an uninstalled or
    // misspelled family degrades gracefully instead of dropping to a serif.
    const stack = fontStack(ui, 'ui');
    root.style.setProperty('--font-body', stack);
    root.style.setProperty('--font-display', stack);
  } else {
    root.style.removeProperty('--font-body');
    root.style.removeProperty('--font-display');
  }
}

function mergePatch(base: AppSettings, patch: SettingsPatch): AppSettings {
  return {
    ...base,
    appearance: { ...base.appearance, ...(patch.appearance ?? {}) },
    editor: { ...base.editor, ...(patch.editor ?? {}) },
    terminal: { ...base.terminal, ...(patch.terminal ?? {}) },
    devtools: { ...base.devtools, ...(patch.devtools ?? {}) },
    browser: { ...base.browser, ...(patch.browser ?? {}) },
    window: { ...base.window, ...(patch.window ?? {}) },
    lanes: { ...base.lanes, ...(patch.lanes ?? {}) },
    agent: { ...base.agent, ...(patch.agent ?? {}) },
    pcControl: { ...base.pcControl, ...(patch.pcControl ?? {}) },
    storage: { ...base.storage, ...(patch.storage ?? {}) },
  };
}

let initialized = false;

export const useSettingsStore = create<SettingsState & SettingsActions>(
  (set, get) => ({
    settings: DEFAULT_SETTINGS,
    loaded: false,
    category: 'appearance',

    setCategory: (category) => set({ category }),

    init: async () => {
      if (initialized) return;
      initialized = true;

      // Live updates from main (a settings:set from any surface).
      window.marudesk.on('settings:changed', (next) => {
        set({ settings: next });
        applyAppearance(next);
      });

      // Re-apply when the OS theme flips while we're tracking 'system'.
      if (typeof window !== 'undefined' && window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: light)');
        mq.addEventListener('change', () => {
          if (get().settings.appearance.theme === 'system') {
            applyAppearance(get().settings);
          }
        });
      }

      try {
        const loaded = await window.marudesk.invoke('settings:get');
        set({ settings: loaded, loaded: true });
        applyAppearance(loaded);
      } catch {
        set({ loaded: true });
        applyAppearance(get().settings);
      }
    },

    update: async (patch) => {
      // Optimistic merge + apply so theme/zoom feel instant; main reconciles
      // with the sanitized result (and broadcasts it back).
      const merged = mergePatch(get().settings, patch);
      set({ settings: merged });
      applyAppearance(merged);
      try {
        const saved = await window.marudesk.invoke(
          'settings:set',
          patch,
        );
        set({ settings: saved });
        applyAppearance(saved);
      } catch {
        // Keep the optimistic state; a later settings:changed corrects it.
      }
    },

    reset: async () => {
      const saved = await window.marudesk.invoke('settings:reset');
      set({ settings: saved });
      applyAppearance(saved);
    },
  }),
);

/**
 * Open Settings, optionally on a given category. Mission Control is the only
 * surface now, so Settings opens as a full-area instrument (the dock hosts it)
 * rather than a tab in a strip that no longer exists.
 */
export async function openSettingsTab(
  category?: SettingsCategory,
): Promise<void> {
  if (category) useSettingsStore.getState().setCategory(category);
  await openInstrument('settings');
}

/**
 * React to appearance changes from one place: fires `listener` immediately,
 * on every settings change, and when the OS theme flips while tracking
 * 'system'. The editor and terminal surfaces use this instead of each
 * re-rolling the store-subscribe + matchMedia wiring. Returns an unsubscribe.
 */
export function subscribeAppearance(
  listener: (settings: AppSettings) => void,
): () => void {
  listener(useSettingsStore.getState().settings);
  const unsubStore = useSettingsStore.subscribe((st) => listener(st.settings));
  let unsubMq = () => {};
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      const s = useSettingsStore.getState().settings;
      if (s.appearance.theme === 'system') listener(s);
    };
    mq.addEventListener('change', onChange);
    unsubMq = () => mq.removeEventListener('change', onChange);
  }
  return () => {
    unsubStore();
    unsubMq();
  };
}
