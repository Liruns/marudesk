/**
 * Persisted user settings. The shape is intentionally sectioned
 * (appearance / terminal / devtools) so new sections can be added without
 * churning call sites. `sanitizeSettings` is the trust boundary: anything that
 * crosses IPC from the renderer (or is read off disk) is coerced back into a
 * valid AppSettings, clamping numbers and rejecting unknown enum values, so the
 * main process never acts on malformed input.
 */

import { asBool, asEnum, asRecord, asString, clampFraction, clampNumber } from './coerce.ts';

export type ThemeMode = 'dark' | 'light' | 'system';
/**
 * Full-surface theme palettes — applied as a `[data-palette]` attribute on
 * <html> (tokens.css owns the actual colors). Orthogonal to BOTH the dark/light
 * mode and the accent: every palette ships a dark and a light half, so
 * palette × mode × accent compose freely. 'default' is the base Linear
 * graphite and clears the attribute.
 */
export const THEME_PALETTES = ['default', 'midnight', 'espresso', 'fjord', 'paper'] as const;
export type ThemePalette = (typeof THEME_PALETTES)[number];
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
 * - `plan`: research-only (like read-only) but the agent is instructed to end
 *   with a concrete step-by-step plan instead of editing (claude-code plan mode).
 */
export type AgentApprovalMode = 'read-only' | 'ask' | 'auto' | 'plan';

/**
 * Which surface the AI-Chat open intents land on (chat CLI v2 —
 * docs/chat-cli-tui-design.md §6.2): the React chat drawer/panel, or an
 * "AI Chat (CLI)" terminal tab running the bundled chat CLI.
 */
export type ChatSurface = 'panel' | 'cli';

/**
 * What the window's close button does: 'quit' exits the app; 'tray' hides the
 * window and keeps marudesk running in the background behind a tray icon
 * (Settings → Window). 'tray' is the default so closing the window never kills
 * in-flight agent turns, terminals, or the remote bridge by surprise.
 */
export type CloseBehavior = 'quit' | 'tray';

/**
 * How hard a reasoning ("extended thinking") model should think before answering
 * — a single standard enum the loop maps to each provider's native knob (OpenAI
 * `reasoningEffort`, Anthropic thinking `budgetTokens`, Google `thinkingLevel`).
 * Only models the catalog marks `reasoning` honor it; non-reasoning models ignore
 * it entirely. See electron/agent/loop.ts.
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/**
 * A specific model to run, as a (provider, model-id) pair — the unit of the
 * agent's fail-over chain. `provider` is really a {@link ProviderId}, but kept
 * as a bare string here so settings stays decoupled from the provider catalog;
 * the agent loop resolves each ref's credentials at fail-over time and skips any
 * that aren't connected.
 */
export type ModelRef = { provider: string; model: string };

export type AppSettings = {
  version: 1;
  appearance: {
    /** dark | light | system (system follows the OS preference at runtime). */
    theme: ThemeMode;
    /** Named surface palette layered under the mode ('default' = base graphite). */
    palette: ThemePalette;
    /** Empty string = use the design-token default UI font stack. */
    uiFontFamily: string;
    /** Whole-UI scale, percent (VSCode-style zoom). 100 = design baseline. */
    uiZoom: number;
    /** AI chat transcript scale, percent (reading comfort; composer/chrome unaffected). */
    chatZoom: number;
    /** Empty string = use the monospace token default. */
    editorFontFamily: string;
    editorFontSize: number;
    terminalFontFamily: string;
    terminalFontSize: number;
  };
  editor: {
    /**
     * Run the language's Monaco format provider on the buffer before each save
     * (TS/JS/JSON/CSS/HTML have built-ins). Languages without a formatter save
     * unformatted — formatting failures never block the write.
     */
    formatOnSave: boolean;
    /**
     * GitLens-style inline blame: a dim end-of-line annotation on the current
     * cursor line ("author, relative time · summary"). Hidden while the buffer
     * has unsaved edits so it can't flicker or mislabel lines mid-typing.
     */
    inlineBlame: boolean;
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
  window: {
    /** Close button: quit the app, or hide to the tray and keep running. */
    closeBehavior: CloseBehavior;
  };
  lanes: {
    /**
     * Command started per worktree lane's directory by the lanes board's dev
     * server control (§3.8 Mission Control), e.g. `npm run dev`. Empty = off.
     */
    devCommand: string;
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
    /**
     * Standing system instructions added to every agent turn — the user's own
     * preferences (tone, conventions, what to avoid). Prepended after the base
     * prompt, before any workspace AGENTS/CLAUDE files. Empty = none.
     */
    instructions: string;
    /**
     * How hard a reasoning model thinks before answering — see
     * {@link ReasoningEffort}. Applied only when the selected model is a reasoning
     * model (the loop maps it to the provider's native knob); ignored otherwise.
     */
    reasoningEffort: ReasoningEffort;
    /**
     * Model fail-over chain: when the active model hits a rate limit / quota
     * (429) or a transient server error (5xx), the agent retries the in-flight
     * step on the next *connected* model in `order` before giving up. Off by
     * default; `order` is the user's ranked list of (provider, model) pairs.
     */
    fallback: { enabled: boolean; order: ModelRef[] };
    /**
     * Automatic compaction (claude-code / cursor parity). When the running
     * context grows past `threshold` of the active model's window, the agent
     * compacts the conversation once a turn settles — summarizing the earlier
     * turns while keeping a verbatim tail and the full visible scrollback. Off
     * leaves compaction manual (`/compact`). `threshold` is a 0–1 fraction of the
     * context window (clamped to a sane band on load).
     */
    autoCompact: { enabled: boolean; threshold: number };
    /**
     * Post-edit verification command (claude-code / codex PostToolUse hook). When
     * set, the agent runs it in the workspace at the end of any turn that edited
     * files and folds the PASS/FAIL result back into the conversation, so a broken
     * edit is caught and visible to both the user and the next turn. Empty = off.
     * Example: `npm run typecheck`.
     */
    verifyCommand: string;
    /**
     * Context hook (claude-code UserPromptSubmit parity). When set, the agent runs
     * this command in the workspace at the START of every turn and folds its output
     * into that turn's model-facing context (e.g. `git status -sb`, a test summary,
     * a deploy state probe) — so the model always sees fresh, project-specific
     * context the user chose, without a tool call. Empty = off. User-configured
     * (trusted, opt-in); output is scrubbed + clipped and framed as reference data.
     */
    contextCommand: string;
    /**
     * File-edit approval (v5 §G1). `auto-apply` (default) writes edits straight to
     * disk in Ask/Auto mode — the chat's accept/revert is the safety net.
     * `preview` instead parks edit_file/multi_edit for approval in Ask mode,
     * showing the proposed diff BEFORE writing (Codex/Claude parity), for users
     * who'd rather confirm each change. Read-only/Plan block edits regardless;
     * Auto always applies (the user opted out of confirmations).
     */
    editApproval: 'auto-apply' | 'preview';
    /**
     * Per-tool deny list (v6 §W7) — gated tools the agent may never run, blocked
     * outright in EVERY mode (the tool-level twin of {@link denyGlobs} for files).
     * e.g. `run_command`, `eval_js`. Manageable in Settings → Agent. Empty = none.
     */
    denyTools: string[];
    /**
     * Tools the user chose "Allow always" for, persisted across sessions (v6
     * §W7/U10) so a trusted gated tool isn't re-prompted in every new conversation.
     * Reviewable/revocable in Settings → Agent. A deny entry always wins over this.
     */
    alwaysAllowTools: string[];
    /**
     * Delegate model for role routing (v6 §G5/U7). When set, spawned subagents and
     * background agents default to THIS model instead of inheriting the parent's —
     * route delegated subtasks to a cheaper/faster model to cut cost. The model can
     * still override per-call; null = inherit the parent model (default, no change).
     */
    subagentModel: ModelRef | null;
    /**
     * Which surface the AI-Chat open intents (titlebar toggle, console
     * "Fix this") land on (chat CLI v2 — docs/chat-cli-tui-design.md §6.2):
     * `panel` (default) opens the chat drawer; `cli` opens/focuses an
     * "AI Chat (CLI)" terminal tab running the bundled chat CLI.
     */
    chatSurface: ChatSurface;
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
   * What the app persists to disk between launches — managed from Settings →
   * Data & Storage. App settings themselves are always saved (they're the
   * record of these very toggles); these govern the optional, higher-volume
   * stores so a user can keep the app stateless if they prefer.
   */
  storage: {
    /**
     * Save AI Chat sessions (transcripts) to the local store so they appear in
     * the sessions history and can be resumed. Off = conversations are
     * in-memory only and vanish on New chat / restart; the loop skips
     * persistSession. Existing saved sessions are not deleted by toggling off.
     */
    persistSessions: boolean;
    /**
     * Restore the open tab set (web pages + saved editor files) on launch — not
     * just pinned tabs. Off = only pinned tabs restore (the prior behavior).
     */
    persistTabs: boolean;
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
    /**
     * Cloud relay (Bridge Model B — docs/bridge-model-b-design.md §B2). When
     * `cloudEnabled` is on AND a cloud account is logged in, the PC holds an
     * OUTBOUND host WS to the relay at `relayUrl` so a phone on the same account
     * can drive the AI Chat from anywhere. Off by default; `relayUrl` is the
     * non-secret base URL (the account tokens live encrypted in secrets.ts).
     */
    relayUrl: string;
    cloudEnabled: boolean;
    /**
     * Optional public base URL where THIS PC's bridge is reachable from outside
     * the LAN — a self-hosted tunnel (cloudflared/ngrok) or reverse proxy the
     * user runs in front of `http://localhost:<port>`. When set it is included
     * in the pairing QR's connect candidates (tried first), so a phone pairs
     * once and reaches the PC from any network with no cloud relay and nothing
     * installed on the phone. '' = none.
     */
    publicUrl: string;
    /**
     * Unattended mode (T2 — docs/t2-secure-pairing-design.md). When on AND the
     * server is enabled, it skips BOTH human approval gates so a phone can drive
     * the PC hands-free: (1) device pairing auto-approves (no desktop card), and
     * (2) gated agent tools (eval_js / cookies / storage / terminal) auto-run
     * instead of waiting for approval. Off by default; a security trade-off only
     * for a setup + network you fully trust. `read-only` agent mode still refuses
     * writes/eval regardless.
     */
    skipApprovals: boolean;
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
  editor?: Partial<AppSettings['editor']>;
  terminal?: Partial<AppSettings['terminal']>;
  devtools?: Partial<AppSettings['devtools']>;
  browser?: Partial<AppSettings['browser']>;
  window?: Partial<AppSettings['window']>;
  lanes?: Partial<AppSettings['lanes']>;
  agent?: Partial<AppSettings['agent']>;
  pcControl?: Partial<AppSettings['pcControl']>;
  server?: Partial<AppSettings['server']>;
  storage?: Partial<AppSettings['storage']>;
};

/** Default cloud-relay base URL — the B1 relay's localhost dev port. */
export const DEFAULT_RELAY_URL = 'http://127.0.0.1:8788';

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  appearance: {
    theme: 'dark',
    palette: 'default',
    uiFontFamily: '',
    uiZoom: 100,
    chatZoom: 100,
    editorFontFamily: '',
    editorFontSize: 13,
    terminalFontFamily: '',
    terminalFontSize: 13,
  },
  editor: {
    formatOnSave: false,
    inlineBlame: true,
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
  window: {
    closeBehavior: 'tray',
  },
  lanes: {
    devCommand: '',
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
    instructions: '',
    reasoningEffort: 'medium',
    fallback: { enabled: false, order: [] },
    autoCompact: { enabled: true, threshold: 0.8 },
    verifyCommand: '',
    contextCommand: '',
    editApproval: 'auto-apply',
    denyTools: [],
    alwaysAllowTools: [],
    subagentModel: null,
    chatSurface: 'panel',
  },
  pcControl: {
    enabled: false,
  },
  server: {
    enabled: false,
    port: 8787,
    relayUrl: DEFAULT_RELAY_URL,
    cloudEnabled: false,
    publicUrl: '',
    skipApprovals: false,
  },
  storage: {
    persistSessions: true,
    persistTabs: true,
  },
};

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const UI_ZOOM_MIN = 50;
export const UI_ZOOM_MAX = 200;
export const CHAT_ZOOM_MIN = 80;
export const CHAT_ZOOM_MAX = 160;
/** rem anchor: text-scale tokens are authored relative to this px base. */
export const UI_ZOOM_BASE_PX = 16;
/** Bridge-server port range — below 1024 needs privilege; cap at the TCP max. */
export const SERVER_PORT_MIN = 1024;
export const SERVER_PORT_MAX = 65535;

const THEMES: readonly ThemeMode[] = ['dark', 'light', 'system'];
const DOCKS: readonly DevtoolsDock[] = ['right', 'bottom', 'chrome'];
const SEARCH_ENGINES: readonly SearchEngine[] = ['google', 'duckduckgo', 'bing'];
const APPROVAL_MODES: readonly AgentApprovalMode[] = ['read-only', 'ask', 'auto', 'plan'];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];
const CHAT_SURFACES: readonly ChatSurface[] = ['panel', 'cli'];
const CLOSE_BEHAVIORS: readonly CloseBehavior[] = ['quit', 'tray'];
const MAX_DENY_GLOBS = 100;

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

/**
 * Coerce a cloud-relay base URL: a trimmed http(s) URL (trailing slash stripped),
 * else the fallback. A non-URL or non-http(s) value can never reach the relay
 * client (which would otherwise build a request against junk).
 */
function asRelayUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return fallback;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? trimmed : fallback;
  } catch {
    return fallback;
  }
}

/** Like {@link asRelayUrl}, but an empty string is honored — it means "no public URL". */
function asOptionalBaseUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  if (value.trim().length === 0) return '';
  return asRelayUrl(value, fallback);
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

const MAX_FALLBACK_MODELS = 20;

/**
 * Coerce the fail-over chain: an array of {provider, model} pairs with both
 * fields non-empty strings, capped. A non-array falls back; an all-invalid array
 * yields []; an empty array is honored (the user cleared the chain).
 */
function asModelRefOrNull(value: unknown, fallback: ModelRef | null): ModelRef | null {
  if (value === null) return null;
  if (value === undefined) return fallback;
  const r = asRecord(value);
  const provider = typeof r.provider === 'string' ? r.provider.trim() : '';
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  return provider && model ? { provider, model } : fallback;
}

function asModelRefArray(value: unknown, fallback: ModelRef[]): ModelRef[] {
  if (!Array.isArray(value)) return fallback;
  const out: ModelRef[] = [];
  for (const item of value) {
    const r = asRecord(item);
    const provider = typeof r.provider === 'string' ? r.provider.trim() : '';
    const model = typeof r.model === 'string' ? r.model.trim() : '';
    if (provider && model) out.push({ provider, model });
    if (out.length >= MAX_FALLBACK_MODELS) break;
  }
  return out;
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
  const ed = asRecord(root.editor);
  const t = asRecord(root.terminal);
  const d = asRecord(root.devtools);
  const b = asRecord(root.browser);
  const w = asRecord(root.window);
  const ln = asRecord(root.lanes);
  const ag = asRecord(root.agent);
  const pc = asRecord(root.pcControl);
  const sv = asRecord(root.server);
  const st = asRecord(root.storage);

  return {
    version: 1,
    appearance: {
      theme: asEnum(a.theme, THEMES, base.appearance.theme),
      palette: asEnum(a.palette, THEME_PALETTES, base.appearance.palette),
      uiFontFamily: asString(a.uiFontFamily, base.appearance.uiFontFamily),
      uiZoom: clampNumber(
        a.uiZoom,
        base.appearance.uiZoom,
        UI_ZOOM_MIN,
        UI_ZOOM_MAX,
      ),
      chatZoom: clampNumber(
        a.chatZoom,
        base.appearance.chatZoom,
        CHAT_ZOOM_MIN,
        CHAT_ZOOM_MAX,
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
    editor: {
      formatOnSave: asBool(ed.formatOnSave, base.editor.formatOnSave),
      inlineBlame: asBool(ed.inlineBlame, base.editor.inlineBlame),
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
    window: {
      closeBehavior: asEnum(w.closeBehavior, CLOSE_BEHAVIORS, base.window.closeBehavior),
    },
    lanes: {
      devCommand: asString(ln.devCommand, base.lanes.devCommand),
    },
    agent: {
      approvalMode: asEnum(ag.approvalMode, APPROVAL_MODES, base.agent.approvalMode),
      denyGlobs: asStringArray(ag.denyGlobs, base.agent.denyGlobs),
      instructions: asString(ag.instructions, base.agent.instructions),
      reasoningEffort: asEnum(ag.reasoningEffort, REASONING_EFFORTS, base.agent.reasoningEffort),
      fallback: {
        enabled: asBool(asRecord(ag.fallback).enabled, base.agent.fallback.enabled),
        order: asModelRefArray(asRecord(ag.fallback).order, base.agent.fallback.order),
      },
      autoCompact: {
        enabled: asBool(asRecord(ag.autoCompact).enabled, base.agent.autoCompact.enabled),
        threshold: clampFraction(
          asRecord(ag.autoCompact).threshold,
          base.agent.autoCompact.threshold,
          0.5,
          0.95,
        ),
      },
      verifyCommand: asString(ag.verifyCommand, base.agent.verifyCommand),
      contextCommand: asString(ag.contextCommand, base.agent.contextCommand),
      editApproval: ag.editApproval === 'preview' ? 'preview' : base.agent.editApproval,
      denyTools: asStringArray(ag.denyTools, base.agent.denyTools),
      alwaysAllowTools: asStringArray(ag.alwaysAllowTools, base.agent.alwaysAllowTools),
      subagentModel: asModelRefOrNull(ag.subagentModel, base.agent.subagentModel),
      chatSurface: asEnum(ag.chatSurface, CHAT_SURFACES, base.agent.chatSurface),
    },
    pcControl: {
      enabled: asBool(pc.enabled, base.pcControl.enabled),
    },
    storage: {
      persistSessions: asBool(st.persistSessions, base.storage.persistSessions),
      persistTabs: asBool(st.persistTabs, base.storage.persistTabs),
    },
    server: {
      enabled: asBool(sv.enabled, base.server.enabled),
      port: clampNumber(sv.port, base.server.port, SERVER_PORT_MIN, SERVER_PORT_MAX),
      relayUrl: asRelayUrl(sv.relayUrl, base.server.relayUrl),
      cloudEnabled: asBool(sv.cloudEnabled, base.server.cloudEnabled),
      publicUrl: asOptionalBaseUrl(sv.publicUrl, base.server.publicUrl),
      skipApprovals: asBool(sv.skipApprovals, base.server.skipApprovals),
    },
  };
}
