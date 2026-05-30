import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  UI_ZOOM_BASE_PX,
  type AppSettings,
  type SettingsPatch,
  type ThemeMode,
} from '../../../shared/settings';
import { useTabsStore } from '../tabs/store';

export type { SettingsPatch };

/** The Settings surface is split into VSCode-style categories (left nav). */
export type SettingsCategory =
  | 'appearance'
  | 'editor'
  | 'terminal'
  | 'browser'
  | 'providers'
  | 'devtools'
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
  root.dataset.theme = resolveTheme(s.appearance.theme);
  // Cache the mode for the pre-paint guard in index.html (kills theme FOUC on
  // next launch). This only governs marudesk's own chrome — embedded web views
  // render in a separate partition and are intentionally unaffected.
  try {
    localStorage.setItem('marudesk.theme', s.appearance.theme);
  } catch {
    // localStorage may be unavailable; the guard is best-effort.
  }
  root.style.fontSize = `${(UI_ZOOM_BASE_PX * s.appearance.uiZoom) / 100}px`;
  const ui = s.appearance.uiFontFamily.trim();
  if (ui) {
    root.style.setProperty('--font-body', ui);
    root.style.setProperty('--font-display', ui);
  } else {
    root.style.removeProperty('--font-body');
    root.style.removeProperty('--font-display');
  }
}

function mergePatch(base: AppSettings, patch: SettingsPatch): AppSettings {
  return {
    ...base,
    appearance: { ...base.appearance, ...(patch.appearance ?? {}) },
    terminal: { ...base.terminal, ...(patch.terminal ?? {}) },
    devtools: { ...base.devtools, ...(patch.devtools ?? {}) },
    browser: { ...base.browser, ...(patch.browser ?? {}) },
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

/** Open (or focus) the singleton Settings tab, optionally on a given category. */
export async function openSettingsTab(
  category?: SettingsCategory,
): Promise<void> {
  if (category) useSettingsStore.getState().setCategory(category);
  const tabsState = useTabsStore.getState();
  const existing = tabsState.tabs.find((t) => t.kind === 'settings');
  if (existing) await tabsState.activateTab(existing.id);
  else await tabsState.newTab('settings');
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
