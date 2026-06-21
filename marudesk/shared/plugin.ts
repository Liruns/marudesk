/**
 * Plugin runtime — transport-safe contracts (docs/plugin-runtime-design.md).
 *
 * This module is the one source of truth shared across the plugin manager (main),
 * the isolated worker (pure Node), the headless harness, and — later — the
 * renderer settings panel. It MUST stay free of Electron / Node-runtime imports so
 * every side can depend on it. Everything here is structured-clone-safe: plain
 * data only, no closures (a function can't cross the worker↔main↔renderer boundary
 * — see design §R1/§5).
 */

/** A capability a plugin may declare in its manifest and the user must approve. */
export type PluginPermission =
  | 'tools' // registerTool
  | 'commands' // registerSlashCommand
  | 'fs:read' // ctx.fs.read/list (read-only; P1)
  | 'fs:write' // ctx.fs.write (P3 — needs AppliedChange diff wiring)
  | 'net' // ctx.http.fetch (P3 — host-mediated, allowlisted)
  | 'cmd' // ctx.exec — run a project CLI, host-mediated (same spawn as run_command)
  | 'ui'; // a sandboxed UI panel (v2 — manifest `panel`)

export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'tools',
  'commands',
  'fs:read',
  'fs:write',
  'net',
  'cmd',
  'ui',
];

/** Reserved server-name prefix for synthetic plugin MCP servers (design §1.1). */
export const PLUGIN_SERVER_PREFIX = 'plugin:';

/** Custom scheme that serves a plugin's sandboxed UI panel files (v2, §8.5). */
export const PLUGIN_SCHEME = 'plugin';

/** The `manifest.json` a plugin ships, as parsed from a trusted scan (design §2). */
export type PluginManifest = {
  /** `[a-z0-9-]`, must equal the folder name. */
  id: string;
  name: string;
  /** semver, display-only. */
  version: string;
  description?: string;
  /** Entry module relative to the plugin folder; may not escape it. */
  main: string;
  /** Host-API compatibility range, e.g. `{ marudesk: '^1.0.0' }`. */
  engine?: { marudesk?: string };
  permissions?: PluginPermission[];
  /** Allowlisted hosts for `ctx.http`; only meaningful with the `net` permission. */
  net?: { allow?: string[] };
  /** A sandboxed UI panel; only meaningful with the `ui` permission (v2, §8.5). */
  panel?: PluginPanel;
};

/** A plugin's UI panel declaration. `entry` is a plugin-folder-relative HTML file. */
export type PluginPanel = { title: string; entry: string };

/** Lifecycle state surfaced to the settings panel / IPC (mirrors McpServerStatus). */
export type PluginState =
  | 'active' // loaded, activated, tools registered
  | 'disabled' // present but not enabled
  | 'needs-approval' // enabled but a declared/changed permission is unapproved
  | 'error'; // failed to parse / load / activate

export type PluginStatus = {
  id: string;
  name: string;
  version: string;
  scope: 'user' | 'project';
  /** True when a project plugin shadows an installed user plugin with the same id. */
  hasUserInstall?: boolean;
  state: PluginState;
  /** Permissions the manifest declares. */
  permissions: PluginPermission[];
  /** Permissions the user has approved (subset of declared). */
  granted: PluginPermission[];
  /** Tool names this plugin contributes (namespaced), for the UI. */
  toolNames: string[];
  /** Slash command names this plugin contributes. */
  commandNames: string[];
  /** The declared UI panel, when the plugin has one + holds the `ui` grant (v2). */
  panel?: PluginPanel;
  /** Scrubbed error message when `state === 'error'`. */
  error?: string;
};

/** Persisted per-plugin enable + grant state (design §config). */
export type PluginConfigEntry = {
  id: string;
  enabled: boolean;
  granted: PluginPermission[];
  /** Hash of the approved manifest's permissions, to detect a change → re-approve. */
  approvedPermissionsKey?: string;
};

export type PluginsConfigFile = {
  plugins: PluginConfigEntry[];
};

/* ── Contributions (worker → host, collected during activate) ─────────────── */

/** A tool a plugin registers; `exec` lives in the worker and runs over RPC. */
export type PluginToolContribution = {
  /** Plugin-local slug (unique within the plugin); host namespaces it. */
  name: string;
  description: string;
  /** JSON-Schema object describing the tool input. */
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
};

/** A slash command a plugin registers — a prompt TEMPLATE, never a closure (§R1). */
export type PluginSlashContribution = {
  name: string;
  description: string;
  argHint?: string;
  /** Prompt template; the renderer substitutes `$ARGUMENTS` with trailing text. */
  template: string;
};

export type PluginContributions = {
  tools: PluginToolContribution[];
  commands: PluginSlashContribution[];
};

/** A live plugin slash command, tagged with its plugin, for the renderer menu. */
export type PluginCommandSnapshot = PluginSlashContribution & { pluginId: string };

/* ── RPC envelope (host ↔ worker, structured-clone-safe) ──────────────────── */

/**
 * Plugin lifecycle phase the host announces to the worker (SECOND-PASS "Plugin
 * onSession lifecycle callback"). A `deactivate` tears the worker down; these are
 * softer signals a stateful plugin can hook to reset per-conversation state
 * WITHOUT being torn down: `session-start` on a new/resumed conversation,
 * `session-end` when one ends. Distinct from `deactivate` (process shutdown).
 */
export type PluginSessionPhase = 'session-start' | 'session-end';

/** The result of a host-mediated `ctx.exec` — a project CLI run (design §4). */
export type PluginExecResult = {
  /** Process exit code, or null when killed by a signal / timeout. */
  exitCode: number | null;
  /** Combined stdout+stderr, scrubbed and bounded. */
  output: string;
  /** True when the run hit the time limit. */
  timedOut: boolean;
};

/** Messages the host sends to the worker. */
export type HostToWorker =
  | { kind: 'load'; pluginDir: string; main: string; granted: PluginPermission[] }
  | { kind: 'callTool'; id: number; name: string; callId: string; input: unknown }
  | { kind: 'resolve'; id: number; ok: true; value: unknown } // answer to a perm RPC
  | { kind: 'resolve'; id: number; ok: false; error: string }
  // Conversation lifecycle (item: onSession). The worker may implement
  // onSessionStart/onSessionEnd; absent handlers are a no-op.
  | { kind: 'session'; phase: PluginSessionPhase; sessionId: string }
  | { kind: 'deactivate' };

/** A permission request the worker asks the host to fulfil (carries its callId). */
export type WorkerPermissionRequest =
  | { kind: 'perm'; id: number; op: 'fs.read'; callId: string; path: string }
  | { kind: 'perm'; id: number; op: 'fs.list'; callId: string; path: string }
  | { kind: 'perm'; id: number; op: 'fs.write'; callId: string; path: string; data: string }
  | { kind: 'perm'; id: number; op: 'http.fetch'; callId: string; url: string }
  // ctx.exec — run a workspace CLI through the host (same guarded spawn as the
  // run_command tool), gated on the `cmd` permission. Carries its callId so the
  // host runs it against the originating tool call's workspace + abort signal.
  | { kind: 'perm'; id: number; op: 'exec'; callId: string; command: string; timeoutMs?: number };

/** Messages the worker sends to the host. */
export type WorkerToHost =
  | { kind: 'ready'; contributions: PluginContributions }
  | { kind: 'loadError'; error: string }
  | { kind: 'result'; id: number; ok: true; text: string }
  | { kind: 'result'; id: number; ok: false; error: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  // ctx.setStatus — a keyed status/progress line for a long-running plugin op
  // (one-way; no resolve). An empty `text` clears the key. Carries its callId so
  // the host can scope the status to the originating tool call.
  | { kind: 'status'; callId: string; statusKey: string; text: string }
  | WorkerPermissionRequest;

/** Default timeouts (ms), mirrored from the external-MCP connector. */
export const PLUGIN_LOAD_TIMEOUT_MS = 10_000;
export const PLUGIN_CALL_TIMEOUT_MS = 60_000;

/** Bound a plugin tool result before scrubbing (mirror MAX_TOOL_TEXT). */
export const PLUGIN_MAX_TOOL_TEXT = 24_000;

/** Strip prototype-pollution keys from a structured-clone payload (design §3). */
export function stripProtoKeys<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) stripProtoKeys(item);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    if (Object.prototype.hasOwnProperty.call(record, key)) delete record[key];
  }
  for (const key of Object.keys(record)) stripProtoKeys(record[key]);
  return value;
}

/** Validate a plugin id slug: lowercase alnum + dashes, used as a folder name. */
export function isValidPluginId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/** Namespaced tool name for a plugin's contributed tool. */
export function pluginToolName(pluginId: string, tool: string): string {
  return `${PLUGIN_SERVER_PREFIX}${pluginId}__${tool}`;
}

/** A stable key over a permission set, to detect manifest permission changes. */
export function permissionsKey(perms: readonly PluginPermission[]): string {
  return [...new Set(perms)].sort().join(',');
}

/**
 * A plugin-folder-relative resource path safe to serve over `plugin://` (v2): no
 * absolute paths, no `..` traversal, no backslashes/NUL, no protocol-relative or
 * scheme prefixes. The protocol handler still re-checks realpath stays in the
 * folder; this is the cheap first gate shared by the manifest parser + handler.
 */
export function isSafePanelPath(rel: unknown): rel is string {
  return (
    typeof rel === 'string' &&
    rel.length > 0 &&
    rel.length < 1024 &&
    !rel.includes('\0') &&
    !rel.includes('\\') &&
    !rel.includes(':') &&
    !rel.startsWith('/') &&
    !rel.split('/').includes('..')
  );
}

/* ── Author-facing API (plugin DX) ──────────────────────────────────────────── *
 *
 * The types below are what a PLUGIN AUTHOR codes against — the `ctx` object their
 * `activate(ctx)` receives, plus the tool/command shapes they register. They are
 * NOT consumed by the runtime (the worker builds `ctx` dynamically and validates at
 * call time); they exist purely so an author gets autocomplete + typecheck. They are
 * DERIVED FROM the transport contracts above (PluginToolContribution /
 * PluginSlashContribution / PluginExecResult / PluginPermission) so the author
 * surface can't drift from what the host/worker actually accept.
 *
 * Each member mirrors the real `ctx` built by `electron/plugins/worker.ts`
 * (`makeContext`); the host-side guards live in `electron/plugins/permissions.ts`.
 * Permissions in parentheses are the manifest grant a member requires.
 *
 * Usage from a CommonJS plugin (no build step needed):
 *
 *   /** @type {import('marudesk/shared/plugin').PluginModule} *\/
 *   module.exports = {
 *     activate(ctx) { ctx.registerTool({ ... }); },
 *   };
 */

/** What a tool handler returns: a plain string, or `{ text }`. The host clips, */
/** scrubs, and frames it as untrusted data before the model sees it. */
export type PluginToolHandlerResult = string | { text: string };

/**
 * A tool an author registers via `ctx.registerTool`. Extends the transport-safe
 * {@link PluginToolContribution} (name/description/inputSchema — what the host
 * advertises to the model) with the `handler` that runs in the worker on each call.
 * `input` arrives as the model's JSON arguments (validate it yourself — it is
 * `unknown`, matching the worker's runtime check). Requires the `tools` permission.
 */
export type PluginTool = PluginToolContribution & {
  handler(input: unknown): PluginToolHandlerResult | Promise<PluginToolHandlerResult>;
};

/**
 * A slash command an author registers via `ctx.registerSlashCommand`. This is
 * exactly the transport-safe {@link PluginSlashContribution} — a prompt TEMPLATE,
 * never a closure (the renderer substitutes `$ARGUMENTS` with the trailing text).
 * `description` is required on the contribution but the worker defaults a missing
 * one to `''`, so authors may omit it. Requires the `commands` permission.
 */
export type PluginSlashCommand = Omit<PluginSlashContribution, 'description'> & {
  description?: string;
};

/**
 * The capability bridge `ctx` exposes to plugin code, mirroring `makeContext` in
 * `electron/plugins/worker.ts`. Calls a permission gates throw if the grant is
 * absent; the `fs`/`http`/`exec`/`setStatus` members are additionally only callable
 * from inside a running tool handler (they need the originating call's workspace).
 * Every signature here matches the real worker bridge — keep them in sync if the
 * worker changes.
 */
export type PluginContext = {
  /** Register an agent tool. Activate-time only. Requires `tools`. */
  registerTool(def: PluginTool): void;
  /** Register a slash command (prompt template). Activate-time only. Requires `commands`. */
  registerSlashCommand(def: PluginSlashCommand): void;
  /** Guarded, workspace-scoped filesystem access (host re-checks every path). */
  fs: {
    /** Read a workspace-relative text file as UTF-8 (capped). Requires `fs:read`. */
    read(relPath: string): Promise<string>;
    /** List a workspace-relative directory; dir entries end in `/`. Requires `fs:read`. */
    list(relPath: string): Promise<string[]>;
    /**
     * Write/overwrite a workspace-relative text file through the agent's atomic
     * patch apply, so the change appears in the chat diff/revert history (and an
     * identical write is a no-op). Honors the agent's never-edit globs.
     * Requires `fs:write`.
     */
    write(relPath: string, data: string): Promise<void>;
  };
  http: {
    /**
     * Host-mediated outbound GET. Only http(s), only hosts in the manifest's
     * `net.allow`, SSRF/DNS-rebinding guarded, redirects NOT followed, body capped.
     * Returns the status and (truncated) text. Requires `net`.
     */
    fetch(url: string): Promise<{ status: number; text: string }>;
  };
  /**
   * Run a workspace CLI (linter/formatter/build) through the host — the same
   * guarded spawn as the built-in run_command tool (workspace cwd, secret-shaped
   * env stripped, output bounded, time-boxed). The worker can never spawn a process
   * itself. `timeoutMs` is clamped to [1s, 600s] (default 120s). Requires `cmd`.
   */
  exec(command: string, opts?: { timeoutMs?: number }): Promise<PluginExecResult>;
  /**
   * Push a keyed status/progress line for a long-running op (display only, no grant
   * required, handler-scoped). An empty `text` clears the key.
   */
  setStatus(statusKey: string, text: string): void;
  /** Append a line to the plugin's in-app debug log (info level). No grant required. */
  log(...args: unknown[]): void;
};

/** Info passed to the optional conversation-lifecycle handlers. */
export type PluginSessionInfo = { sessionId: string };

/**
 * The shape of a plugin's entry module (CommonJS `module.exports`). Only
 * `activate(ctx)` is required; the rest are optional lifecycle hooks. `activate`
 * runs once at load — register tools/commands there. The optional
 * `onSessionStart`/`onSessionEnd` let a stateful plugin reset per-conversation
 * state WITHOUT being torn down (distinct from process shutdown).
 */
export type PluginModule = {
  activate(ctx: PluginContext): void | Promise<void>;
  onSessionStart?(info: PluginSessionInfo): void | Promise<void>;
  onSessionEnd?(info: PluginSessionInfo): void | Promise<void>;
};
