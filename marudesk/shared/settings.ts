/**
 * Persisted user settings. The shape is intentionally sectioned
 * (appearance / terminal / devtools) so new sections can be added without
 * churning call sites. `sanitizeSettings` is the trust boundary: anything that
 * crosses IPC from the renderer (or is read off disk) is coerced back into a
 * valid AppSettings, clamping numbers and rejecting unknown enum values, so the
 * main process never acts on malformed input.
 */

export type ThemeMode = 'dark' | 'light' | 'system';
/** Where the custom browser DevTools opens: docked to the right, or a window. */
export type DevtoolsDock = 'side' | 'popup';

export type AppSettings = {
  version: 1;
  appearance: {
    /** dark | light | system (system follows the OS preference at runtime). */
    theme: ThemeMode;
    /** Empty string = use the design-token default UI font stack. */
    uiFontFamily: string;
    /** Whole-UI scale, percent (VSCode-style zoom). 100 = design baseline. */
    uiZoom: number;
    /** Empty string = use the monospace token default. */
    editorFontFamily: string;
    editorFontSize: number;
    terminalFontFamily: string;
    terminalFontSize: number;
  };
  terminal: {
    /** Empty string = the OS default shell, resolved per-platform in main. */
    defaultShell: string;
  };
  devtools: {
    /** Where the custom browser DevTools opens by default. */
    defaultDock: DevtoolsDock;
  };
};

/**
 * A partial settings update: one or more whole sections, each with a subset of
 * its fields. Deliberately one level deep — it matches the section-merge in the
 * renderer store and electron/settings.ts, so the compiler rejects an
 * accidentally-deeper patch that the merge wouldn't honor. This is the payload
 * contract for the `settings:set` channel.
 */
export type SettingsPatch = {
  appearance?: Partial<AppSettings['appearance']>;
  terminal?: Partial<AppSettings['terminal']>;
  devtools?: Partial<AppSettings['devtools']>;
};

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  appearance: {
    theme: 'dark',
    uiFontFamily: '',
    uiZoom: 100,
    editorFontFamily: '',
    editorFontSize: 13,
    terminalFontFamily: '',
    terminalFontSize: 13,
  },
  terminal: {
    defaultShell: '',
  },
  devtools: {
    defaultDock: 'side',
  },
};

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const UI_ZOOM_MIN = 50;
export const UI_ZOOM_MAX = 200;
/** rem anchor: text-scale tokens are authored relative to this px base. */
export const UI_ZOOM_BASE_PX = 16;

const THEMES: readonly ThemeMode[] = ['dark', 'light', 'system'];
const DOCKS: readonly DevtoolsDock[] = ['side', 'popup'];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Coerce arbitrary input into a valid AppSettings, using `base` (defaults, or
 * the current settings for a partial update) for any missing/invalid field.
 * Unknown keys are dropped; out-of-range numbers are clamped; bad enums fall
 * back to the base.
 */
export function sanitizeSettings(
  input: unknown,
  base: AppSettings = DEFAULT_SETTINGS,
): AppSettings {
  const root = asRecord(input);
  const a = asRecord(root.appearance);
  const t = asRecord(root.terminal);
  const d = asRecord(root.devtools);

  return {
    version: 1,
    appearance: {
      theme: asEnum(a.theme, THEMES, base.appearance.theme),
      uiFontFamily: asString(a.uiFontFamily, base.appearance.uiFontFamily),
      uiZoom: clampNumber(
        a.uiZoom,
        base.appearance.uiZoom,
        UI_ZOOM_MIN,
        UI_ZOOM_MAX,
      ),
      editorFontFamily: asString(
        a.editorFontFamily,
        base.appearance.editorFontFamily,
      ),
      editorFontSize: clampNumber(
        a.editorFontSize,
        base.appearance.editorFontSize,
        FONT_SIZE_MIN,
        FONT_SIZE_MAX,
      ),
      terminalFontFamily: asString(
        a.terminalFontFamily,
        base.appearance.terminalFontFamily,
      ),
      terminalFontSize: clampNumber(
        a.terminalFontSize,
        base.appearance.terminalFontSize,
        FONT_SIZE_MIN,
        FONT_SIZE_MAX,
      ),
    },
    terminal: {
      defaultShell: asString(t.defaultShell, base.terminal.defaultShell),
    },
    devtools: {
      defaultDock: asEnum(d.defaultDock, DOCKS, base.devtools.defaultDock),
    },
  };
}
