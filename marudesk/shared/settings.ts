/**
 * Persisted user settings. The shape is intentionally sectioned
 * (appearance / terminal / devtools) so new sections can be added without
 * churning call sites. `sanitizeSettings` is the trust boundary: anything that
 * crosses IPC from the renderer (or is read off disk) is coerced back into a
 * valid AppSettings, clamping numbers and rejecting unknown enum values, so the
 * main process never acts on malformed input.
 */

export type ThemeMode = 'dark' | 'light' | 'system';
/**
 * Where the custom browser DevTools opens:
 * - `right` / `bottom`: our own CDP-backed React dock, docked in-window.
 * - `chrome`: the built-in Chromium DevTools in a detached window. Kept as an
 *   escape hatch (device emulation, network throttling, the Sources debugger)
 *   until our panels reach parity — see docs/custom-devtools-design.md §11.1/§14.
 *
 * Migration: the legacy values `'side'`/`'popup'` are no longer valid, so
 * `sanitizeSettings` falls them back to the default. The default is `'right'`,
 * which is the natural successor to the old `'side'` dock (the dominant prior
 * value), so a persisted `'side'` lands on the right dock; a rare persisted
 * `'popup'` falls to `'right'` too (the user is one click from `'chrome'`).
 */
export type DevtoolsDock = 'right' | 'bottom' | 'chrome';

/** Address-bar search provider used when input isn't a URL. */
export type SearchEngine = 'google' | 'duckduckgo' | 'bing';

/**
 * How much the agent may do without asking (docs/agentic-chat-v4-design.md §B4):
 * - `read-only`: read/observe only — file edits and code execution (eval_js) are
 *   refused outright.
 * - `ask`: edits run (they're reviewable/revertable), but sensitive tools
 *   (eval_js, cookies, storage, terminal output) ask for per-call approval.
 * - `auto`: everything runs without approval prompts.
 */
export type AgentApprovalMode = 'read-only' | 'ask' | 'auto';

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
  browser: {
    /** Address-bar search provider for non-URL input. */
    searchEngine: SearchEngine;
  };
  agent: {
    /** How much the AI agent may do without asking — see {@link AgentApprovalMode}. */
    approvalMode: AgentApprovalMode;
    /**
     * Path globs the agent may never edit (matched against workspace-relative
     * paths). A second line of defense for secrets/config beyond the read-side
     * SECRET_FILE guard. `*`/`**` supported.
     */
    denyGlobs: string[];
  };
  /**
   * PC control — whether the agent may act on the computer OUTSIDE the workspace
   * (open files/folders/URLs in their default app, reveal a path in the file
   * manager). Off by default; even when on, each such call asks for approval
   * unless the mode is Auto. See docs/remote-mobile-bridge-design §5.
   */
  pcControl: {
    enabled: boolean;
  };
  /**
   * Remote bridge server — a local HTTP server (127.0.0.1 ONLY) that lets a future
   * companion app drive the AI Chat agent (docs/remote-mobile-bridge-design §M4).
   * Off by default; when on it binds loopback and requires a bearer token. LAN
   * exposure / pairing / auth are later phases (M5/M6).
   */
  server: {
    enabled: boolean;
    /** TCP port for the loopback bind (clamped to 1024–65535). */
    port: number;
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
  browser?: Partial<AppSettings['browser']>;
  agent?: Partial<AppSettings['agent']>;
  pcControl?: Partial<AppSettings['pcControl']>;
  server?: Partial<AppSettings['server']>;
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
    defaultDock: 'right',
  },
  browser: {
    searchEngine: 'google',
  },
  agent: {
    approvalMode: 'ask',
    denyGlobs: [
      '**/.env',
      '**/.env.*',
      '**/*.pem',
      '**/*.key',
      '**/id_rsa',
      '**/id_rsa.*',
      '**/secrets/**',
    ],
  },
  pcControl: {
    enabled: false,
  },
  server: {
    enabled: false,
    port: 8787,
  },
};

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const UI_ZOOM_MIN = 50;
export const UI_ZOOM_MAX = 200;
/** rem anchor: text-scale tokens are authored relative to this px base. */
export const UI_ZOOM_BASE_PX = 16;
/** Bridge-server port range — below 1024 needs privilege; cap at the TCP max. */
export const SERVER_PORT_MIN = 1024;
export const SERVER_PORT_MAX = 65535;

const THEMES: readonly ThemeMode[] = ['dark', 'light', 'system'];
const DOCKS: readonly DevtoolsDock[] = ['right', 'bottom', 'chrome'];
const SEARCH_ENGINES: readonly SearchEngine[] = ['google', 'duckduckgo', 'bing'];
const APPROVAL_MODES: readonly AgentApprovalMode[] = ['read-only', 'ask', 'auto'];
const MAX_DENY_GLOBS = 100;

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

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Sentinel "shell" values that aren't real executables — older/foreign builds
 * (or a hand-edited file) persisted things like `"system"`, which the terminal
 * would then try to spawn literally and fail with a bare `File not found:`.
 * Coerce them to '' ("OS default") so the resolver picks a working shell and the
 * Settings field shows the default placeholder rather than a broken value. The
 * main-process resolver (electron/terminal.ts) applies the same guard.
 */
const SHELL_SENTINELS: readonly string[] = ['system', 'default', 'os', 'auto', 'none'];

function asShell(value: unknown, fallback: string): string {
  const s = asString(value, fallback);
  return SHELL_SENTINELS.includes(s.trim().toLowerCase()) ? '' : s;
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
 * Coerce to a string array (trimmed, non-empty entries, capped). A non-array
 * falls back to `fallback`; an empty array is honored (the user cleared the
 * list) so deny-globs can be intentionally emptied.
 */
function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, MAX_DENY_GLOBS);
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
  const b = asRecord(root.browser);
  const ag = asRecord(root.agent);
  const pc = asRecord(root.pcControl);
  const sv = asRecord(root.server);

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
      defaultShell: asShell(t.defaultShell, base.terminal.defaultShell),
    },
    devtools: {
      defaultDock: asEnum(d.defaultDock, DOCKS, base.devtools.defaultDock),
    },
    browser: {
      searchEngine: asEnum(
        b.searchEngine,
        SEARCH_ENGINES,
        base.browser.searchEngine,
      ),
    },
    agent: {
      approvalMode: asEnum(ag.approvalMode, APPROVAL_MODES, base.agent.approvalMode),
      denyGlobs: asStringArray(ag.denyGlobs, base.agent.denyGlobs),
    },
    pcControl: {
      enabled: asBool(pc.enabled, base.pcControl.enabled),
    },
    server: {
      enabled: asBool(sv.enabled, base.server.enabled),
      port: clampNumber(sv.port, base.server.port, SERVER_PORT_MIN, SERVER_PORT_MAX),
    },
  };
}
