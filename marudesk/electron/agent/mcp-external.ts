import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  isHttpMcpConfig,
  mcpDisplayTarget,
  mcpTransportOf,
  type McpConnectionState,
  type McpServerConfig,
  type McpServerStatus,
} from '../../shared/mcp';
import { toMessage } from '../../shared/to-message';
import { registerMcpServer, unregisterMcpServer, type McpServer } from './mcp';
import type { McpTool, ToolResult } from './tools';
import {
  promptToToolResult,
  resourceToToolResult,
  toToolResult,
  type McpGetPromptResult,
  type McpReadResourceResult,
} from './mcp-content';
import {
  createExternalToolPolicy,
  isExternalToolGated,
  scrubAndClipCapabilityText,
  scrubAndClipToolMetadataText,
  sanitizeExternalInputSchema,
  shouldExposeExternalTool,
  type ExternalToolPolicyOptions,
} from './mcp-runtime-policy';
export { toToolResult } from './mcp-content';

/**
 * External MCP connector manager (docs/context-mcp-design §8). Connects
 * user-configured servers over **stdio** (a
 * spawned local process) or **remote HTTP** (Streamable HTTP, with a legacy SSE
 * fallback) and surfaces their tools to the agent loop.
 *
 * THE invariant: marudesk's agent loop never auto-executes tools — it lists
 * schemas only and routes each call back through `callMcpTool` for approval /
 * read-only / ask_user mediation (electron/agent/loop.ts). So we DO NOT use the AI
 * SDK's `experimental_createMCPClient` (it attaches an auto-running `execute`).
 * Instead we drive the official low-level `@modelcontextprotocol/sdk` `Client`
 * ourselves: `client.listTools()` to discover, and each wrapped tool's `exec`
 * calls `client.callTool(...)`. The wrapped tool is a plain {@link McpTool}, so the
 * loop mediates it exactly like a built-in one.
 *
 * Tool metadata: external tools are namespaced `<id>__<tool>`, grouped `'mcp'`, and
 * `gated: true` by default — they're third-party and side-effecting, so the user
 * approves each call (unless Auto mode). A server the user marks `trust: true` in
 * the config exposes its tools UN-gated (still under read-only/auto rules). External
 * tools are NOT marked `write` (that would make read-only mode blanket-refuse even
 * read tools); gating is the control. A server's `disabledTools` are filtered out
 * entirely so the model never sees them.
 *
 * Graceful failure: a server that fails to connect / initialize is logged, marked
 * `error`, and skipped — it never crashes the app. A connected server whose
 * transport later drops (process exit, network loss) is detected via the client's
 * `onclose` hook, marked `error`, and its tools removed. The default config is
 * empty, so this ships inert (nothing connects until the user configures a server).
 */

/** How long to wait for connect + MCP `initialize` before giving up on a server. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Per tool-call timeout passed to `client.callTool`. */
const CALL_TIMEOUT_MS = 60_000;
/** Bound a tool result before scrubbing so a huge payload can't be fully scanned. */

/** The subset of the MCP `Client` the manager uses — lets the harness inject a mock. */
export type McpClientLike = {
  listTools(): Promise<{ tools: McpExternalToolInfo[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<McpCallToolResult>;
  close(): Promise<void>;
  /** Invoked by the transport when the connection drops — we use it for crash detection. */
  onclose?: () => void;
  /**
   * The capabilities the server advertised at `initialize`. We gate the optional
   * prompts/resources discovery below on this so we never call a method a
   * tools-only server doesn't implement. Present on the real SDK `Client`; optional
   * here so the harness mock can omit it (→ treated as tools-only).
   */
  getServerCapabilities?(): { prompts?: object; resources?: object; tools?: object } | undefined;
  /** Optional — present only when the server advertises the `prompts` capability. */
  listPrompts?(): Promise<{ prompts: McpPromptInfo[] }>;
  getPrompt?(params: { name: string; arguments?: Record<string, string> }): Promise<McpGetPromptResult>;
  /** Optional — present only when the server advertises the `resources` capability. */
  listResources?(): Promise<{ resources: McpResourceInfo[] }>;
  readResource?(params: { uri: string }): Promise<McpReadResourceResult>;
  /**
   * Subscribe to a server→client notification (e.g. `notifications/tools/list_changed`).
   * Present on the real SDK `Client`; optional here so a mock can omit it (→ no live
   * refresh). Loosely typed (the SDK takes a zod schema) — we pass the SDK's own.
   */
  setNotificationHandler?(schema: object, handler: () => void | Promise<void>): void;
};

/**
 * MCP `ToolAnnotations` (spec) — optional behavioral hints a server may attach to a
 * tool. We consume `title` (a friendlier label) and the read-only/destructive hints
 * to decide whether a tool mutates state (see {@link buildExternalServer}); the rest
 * are accepted but unused.
 */
export type McpToolAnnotations = {
  title?: string;
  /** The tool does not modify its environment (a pure read). */
  readOnlyHint?: boolean;
  /** The tool may perform destructive updates (only meaningful when not read-only). */
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** A tool as reported by `client.listTools()` (only the fields we consume). */
export type McpExternalToolInfo = {
  name?: unknown;
  /** A human-readable display name (spec `title`); falls back to `annotations.title`. */
  title?: string;
  description?: string;
  inputSchema?: { type: 'object'; properties?: Record<string, object>; required?: string[] };
  annotations?: McpToolAnnotations;
};

type ExposedMcpExternalToolInfo = McpExternalToolInfo & {
  readonly name: string;
};

/** A prompt as reported by `client.listPrompts()` (only the fields we consume). */
export type McpPromptInfo = {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
};

/** A resource as reported by `client.listResources()` (only the fields we consume). */
export type McpResourceInfo = {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

/** Content item of a `client.callTool` result (text / image / audio / resource / link). */
type McpContentItem =
  | { type: 'text'; text: string }
  | { type: string; [k: string]: unknown };

/** Shape of `client.callTool`'s resolved value (only the fields we map). */
export type McpCallToolResult = {
  content?: McpContentItem[];
  /** A typed JSON payload some tools return alongside (or instead of) content. */
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
};

/** A live connection: its client, the registered server, its status, and the
 *  connector factory it was opened with (reused to reconnect after an unexpected drop). */
type LiveServer = {
  config: McpServerConfig;
  client: McpClientLike;
  status: McpServerStatus;
  connect: ConnectFn;
};

/** Registry of currently connected servers, keyed by config id (= server name). */
const live = new Map<string, LiveServer>();
/** Latest status per configured id (incl. disabled/errored ones the UI lists). */
const statuses = new Map<string, McpServerStatus>();

/* ── MCP-1: deferred-tool exposure during (re)connect ────────────────────────── */

/**
 * In-flight {@link connectServer} calls keyed by id, so two concurrent connect /
 * sync calls for the same server share ONE connection instead of racing. Without
 * this, a second caller would open a second client, register over the first, and
 * leak the first's transport. The promise is removed in a `finally` once it settles.
 */
const pendingConnects = new Map<string, Promise<McpServerStatus>>();

/**
 * The last tool list a server reported, kept so a reconnecting server can expose its
 * previously-known tools IMMEDIATELY (a {@link buildDeferredServer}) instead of
 * adding a full connect round-trip of per-turn latency. Set after a successful
 * `listTools`; cleared only on a DELIBERATE teardown (disconnect / dispose), never on
 * an unexpected drop — so a transient blip keeps serving the cached schema while it
 * reconnects (gajae manager.ts:927).
 */
const lastKnownTools = new Map<string, McpExternalToolInfo[]>();

/** A queued waiter for a server's live client (a deferred tool exec mid-reconnect). */
type ClientWaiter = {
  resolve: (client: McpClientLike) => void;
  reject: (err: Error) => void;
};
/** Pending client waiters per id, drained when the server reconnects (or rejected on teardown). */
const clientResolvers = new Map<string, ClientWaiter[]>();

/**
 * Ids whose tools are currently registered as a DEFERRED placeholder (exposed from
 * cache while a (re)connect is still in flight, before the server is in {@link live}).
 * Teardown uses this to unregister a deferred server that never reached `live` — it
 * wouldn't be caught by iterating `live`. Cleared when the real connection replaces
 * the placeholder, or on teardown.
 */
const deferredRegistered = new Set<string>();

/**
 * Resolve the live client for an id: if the server is already connected, resolve
 * immediately; otherwise queue a waiter that {@link drainClientResolvers} settles
 * when the (re)connect completes. The `signal` (the turn's AbortSignal) rejects the
 * wait if the turn is cancelled while a slow server is still connecting, so a deferred
 * tool call never hangs past its turn. A pre-aborted signal rejects synchronously.
 */
function resolveClientFor(id: string, signal: AbortSignal): Promise<McpClientLike> {
  const entry = live.get(id);
  if (entry) return Promise.resolve(entry.client);
  if (signal.aborted) {
    return Promise.reject(new Error('turn aborted while waiting for MCP server'));
  }
  return new Promise<McpClientLike>((resolve, reject) => {
    const waiter: ClientWaiter = { resolve, reject };
    const queue = clientResolvers.get(id);
    if (queue) queue.push(waiter);
    else clientResolvers.set(id, [waiter]);
    const onAbort = (): void => {
      removeWaiter(id, waiter);
      reject(new Error('turn aborted while waiting for MCP server'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Wrap resolve/reject so the abort listener is always detached once we settle —
    // a settled waiter must not later fire onAbort (it would be a no-op, but we keep
    // the listener set tidy and avoid retaining the closure).
    waiter.resolve = (client) => {
      signal.removeEventListener('abort', onAbort);
      resolve(client);
    };
    waiter.reject = (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    };
  });
}

/** Remove a specific waiter from a server's resolver queue (on abort). */
function removeWaiter(id: string, waiter: ClientWaiter): void {
  const queue = clientResolvers.get(id);
  if (!queue) return;
  const i = queue.indexOf(waiter);
  if (i !== -1) queue.splice(i, 1);
  if (queue.length === 0) clientResolvers.delete(id);
}

/** Hand a freshly-connected client to every waiter queued for this id. */
function drainClientResolvers(id: string, client: McpClientLike): void {
  const queue = clientResolvers.get(id);
  if (!queue) return;
  clientResolvers.delete(id);
  for (const waiter of queue) waiter.resolve(client);
}

/**
 * Reject every waiter for an id (a deliberate teardown, or a drop with no cached
 * tools). Pending deferred tool calls fail fast with an error ToolResult instead of
 * hanging — so before-quit teardown never leaves a deferred exec dangling.
 */
function rejectClientResolvers(id: string, reason: string): void {
  const queue = clientResolvers.get(id);
  if (!queue) return;
  clientResolvers.delete(id);
  for (const waiter of queue) waiter.reject(new Error(reason));
}

/**
 * Build a placeholder {@link McpServer} from a server's last-known tool list so the
 * model can see (and call) its tools the instant a reconnect starts, without waiting
 * for the connect round-trip. Each tool's `exec` awaits the real client via
 * {@link resolveClientFor} (racing the turn's AbortSignal) and only then issues the
 * real `client.callTool`. The wrapping (namespacing / gating / write derivation) is
 * the SAME as {@link buildExternalServer} so a deferred tool behaves identically to a
 * fully-connected one — it just defers acquiring the client.
 */
export function buildDeferredServer(
  id: string,
  tools: McpExternalToolInfo[],
  opts: ExternalServerOptions = {},
): McpServer {
  const prefix = `${id}__`;
  const policy = createExternalToolPolicy(opts);
  const wrapped: McpTool[] = tools
    .filter((t): t is ExposedMcpExternalToolInfo => shouldExposeExternalTool(t.name, policy, id))
    .map((t) => {
      const toolName = t.name;
      const namespaced = `${prefix}${toolName}`;
      const gated = isExternalToolGated(toolName, policy);
      const write = annotatedAsWrite(t.annotations);
      const title =
        t.title ?? (typeof t.annotations?.title === 'string' ? t.annotations.title : undefined);
      const safeTitle = title ? scrubAndClipToolMetadataText(title) : undefined;
      const label = safeTitle && safeTitle !== toolName ? `${safeTitle} - ${toolName}` : toolName;
      const inputSchema = sanitizeExternalInputSchema(t.inputSchema);
      const description = t.description
        ? `[${id}] ${label}: ${scrubAndClipToolMetadataText(t.description)}`
        : `[${id}] external MCP tool "${label}".`;
      const tool: McpTool = {
        name: namespaced,
        description,
        inputSchema,
        group: 'mcp',
        gated,
        ...(write ? { write: true } : {}),
        async exec(input, ctx): Promise<ToolResult> {
          let client: McpClientLike;
          try {
            // Wait for the real (re)connecting client; the turn's AbortSignal rejects
            // this if the turn is cancelled mid-wait so we never hang. We do NOT close
            // the client on abort — it belongs to the manager, not this call.
            client = await resolveClientFor(id, ctx.signal);
          } catch (err) {
            return {
              summary: `${namespaced} error`,
              text: externalErrorText(namespaced, err),
              isError: true,
            };
          }
          try {
            const res = await client.callTool(
              { name: toolName, arguments: (input ?? {}) as Record<string, unknown> },
              undefined,
              { timeout: CALL_TIMEOUT_MS },
            );
            return toToolResult(namespaced, res);
          } catch (err) {
            return {
              summary: `${namespaced} error`,
              text: externalErrorText(namespaced, err),
              isError: true,
            };
          }
        },
      };
      return tool;
    });
  return { name: id, tools: wrapped };
}

function setStatus(
  config: McpServerConfig,
  state: McpConnectionState,
  toolCount: number,
  extra?: { error?: string; tools?: string[] },
): McpServerStatus {
  const status: McpServerStatus = {
    id: config.id,
    transport: mcpTransportOf(config),
    target: mcpDisplayTarget(config),
    enabled: config.enabled,
    trusted: config.trust === true,
    disabledTools: config.disabledTools ?? [],
    autoApproveTools: config.autoApproveTools ?? [],
    confirmTools: config.confirmTools ?? [],
    state,
    toolCount,
    ...(extra?.tools ? { tools: extra.tools } : {}),
    ...(extra?.error ? { error: scrubAndClipToolMetadataText(extra.error) } : {}),
  };
  statuses.set(config.id, status);
  return status;
}


/** Per-server wrapping options derived from the config (trust + tool filter). */
export type ExternalServerOptions = {
  /** When true, the server's tools are NOT gated (auto-approve). Default false. */
  trusted?: boolean;
  /** Tool names (un-namespaced) to hide from the agent entirely. */
  disabledTools?: readonly string[];
  /**
   * Tool names (un-namespaced) to auto-approve even when the server isn't fully
   * `trusted` — a finer-grained gate-off. Ignored for tools in {@link disabledTools}
   * (those are hidden) and redundant when `trusted` (everything is already un-gated).
   */
  autoApproveTools?: readonly string[];
  /**
   * Tool names (un-namespaced) to KEEP gated even when {@link trusted} — the per-tool
   * deny twin of {@link autoApproveTools}. A tool listed here always wins over
   * `trusted`/`autoApproveTools`, so a broadly-trusted server can still confirm a few
   * high-impact tools per call. Only meaningful when `trusted`.
   */
  confirmTools?: readonly string[];
};

/**
 * Whether an external tool should be treated as a state-mutating ("write") tool —
 * i.e. refused outright in read-only / plan mode. External tools carry no `write`
 * flag by default (so read-only mode doesn't blanket-refuse harmless read tools on a
 * server that declares nothing). We only mark one `write` when the SERVER ITSELF
 * declares it mutating via MCP `annotations`: `readOnlyHint: false` (explicitly not a
 * read) or `destructiveHint: true`. A tool with `readOnlyHint: true`, or no
 * annotations at all, stays non-write (callable in read-only mode but still gated for
 * approval unless trusted/auto-approved).
 */
function annotatedAsWrite(ann: McpToolAnnotations | undefined): boolean {
  if (!ann) return false;
  if (ann.readOnlyHint === true) return false;
  return ann.readOnlyHint === false || ann.destructiveHint === true;
}

/**
 * Wrap a connected client's tools as namespaced {@link McpTool}s. Each `exec`
 * strips the `<id>__` prefix back to the server's own tool name and calls
 * `client.callTool` (with a timeout); the loop mediates it via callMcpTool. A
 * thrown SDK error (timeout / transport) is caught here into an error ToolResult so
 * one bad call can't break the turn.
 *
 * `opts.disabledTools` are filtered out (the model never sees them); `opts.trusted`
 * flips `gated` off so a trusted server's tools auto-approve. Exported for the
 * headless harness.
 */
export function buildExternalServer(
  id: string,
  client: McpClientLike,
  tools: McpExternalToolInfo[],
  opts: ExternalServerOptions = {},
): McpServer {
  const prefix = `${id}__`;
  const policy = createExternalToolPolicy(opts);
  const wrapped: McpTool[] = tools
    .filter((t): t is ExposedMcpExternalToolInfo => shouldExposeExternalTool(t.name, policy, id))
    .map((t) => {
      const toolName = t.name;
      const namespaced = `${prefix}${toolName}`;
      // Gating precedence: a per-tool `confirmTools` deny always wins (keeps the tool
      // gated even on a trusted server); otherwise a whole-server `trust` un-gates
      // everything, and on an untrusted server a per-tool allow-list can un-gate
      // individual tools.
      const gated = isExternalToolGated(toolName, policy);
      const write = annotatedAsWrite(t.annotations);
      // Prefer the spec `title` (or annotations.title) for a friendlier label.
      const title =
        t.title ?? (typeof t.annotations?.title === 'string' ? t.annotations.title : undefined);
      const safeTitle = title ? scrubAndClipToolMetadataText(title) : undefined;
      const label = safeTitle && safeTitle !== toolName ? `${safeTitle} - ${toolName}` : toolName;
      const inputSchema = sanitizeExternalInputSchema(t.inputSchema);
      const description = t.description
        ? `[${id}] ${label}: ${scrubAndClipToolMetadataText(t.description)}`
        : `[${id}] external MCP tool "${label}".`;
      const tool: McpTool = {
        name: namespaced,
        description,
        inputSchema,
        group: 'mcp',
        gated,
        ...(write ? { write: true } : {}),
        async exec(input): Promise<ToolResult> {
          try {
            const res = await client.callTool(
              { name: toolName, arguments: (input ?? {}) as Record<string, unknown> },
              undefined,
              { timeout: CALL_TIMEOUT_MS },
            );
            return toToolResult(namespaced, res);
          } catch (err) {
            return {
              summary: `${namespaced} error`,
              text: externalErrorText(namespaced, err),
              isError: true,
            };
          }
        },
      };
      return tool;
    });
  return { name: id, tools: wrapped };
}

/**
 * Synthesize the prompt/resource access tools for a server that advertises those
 * capabilities. MCP exposes prompts (reusable, server-authored instruction
 * templates) and resources (server-hosted context the model can read by uri) over
 * methods that are NOT tools — but our agent surface is tool-only, and the loop
 * mediates every tool. So we bridge each capability into a small set of namespaced
 * meta-tools the model can call:
 *
 *   `<id>__list_prompts`   — enumerate the server's prompts (read-only)
 *   `<id>__get_prompt`     — expand one prompt into messages (read-only)
 *   `<id>__list_resources` — enumerate the server's resources (read-only)
 *   `<id>__read_resource`  — read one resource by uri (read-only)
 *
 * They're all reads, so none is marked `write` (callable in read-only mode); they
 * follow the same gating as the server's real tools (gated unless trusted /
 * auto-approved). A synthesized name that would collide with a real tool the server
 * already exposes is skipped (the real tool wins). Returns `[]` when the server
 * advertises neither capability — so a tools-only server is unaffected.
 */
export function buildCapabilityTools(
  id: string,
  client: McpClientLike,
  opts: ExternalServerOptions,
  existingNames: ReadonlySet<string>,
): McpTool[] {
  const caps = client.getServerCapabilities?.();
  if (!caps) return [];
  const prefix = `${id}__`;
  const policy = createExternalToolPolicy(opts);
  const out: McpTool[] = [];

  const add = (
    bare: string,
    description: string,
    inputSchema: McpTool['inputSchema'],
    exec: McpTool['exec'],
  ): void => {
    const namespaced = `${prefix}${bare}`;
    // A real tool of the same namespaced name takes precedence — don't shadow it.
    if (existingNames.has(namespaced) || !shouldExposeExternalTool(bare, policy, id)) return;
    out.push({
      name: namespaced,
      description: `[${id}] ${description}`,
      inputSchema,
      group: 'mcp',
      gated: isExternalToolGated(bare, policy),
      exec,
    });
  };

  if (caps.prompts && client.listPrompts && client.getPrompt) {
    const listPrompts = client.listPrompts.bind(client);
    const getPrompt = client.getPrompt.bind(client);
    add(
      'list_prompts',
      `List the prompt templates this MCP server offers (name, description, arguments). Read-only.`,
      { type: 'object', properties: {} },
      async (): Promise<ToolResult> => {
        try {
          const { prompts } = await listPrompts();
          const lines = (Array.isArray(prompts) ? prompts : []).map((p) => {
            const args = (p.arguments ?? [])
              .map((a) => (a.required ? `${a.name}*` : a.name))
              .join(', ');
            const desc = p.description ? ` — ${p.description}` : '';
            return `• ${p.name}${args ? ` (${args})` : ''}${desc}`;
          });
          const text = lines.length > 0 ? lines.join('\n') : '(no prompts)';
          return { summary: `${prefix}list_prompts`, text: scrubAndClipCapabilityText(text) };
        } catch (err) {
          return errorResult(`${prefix}list_prompts`, err);
        }
      },
    );
    add(
      'get_prompt',
      `Expand one of this server's prompt templates into messages. Args: { name, arguments? }. Read-only.`,
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The prompt name from list_prompts.' },
          arguments: { type: 'object', description: 'Prompt argument values (string→string).' },
        },
        required: ['name'],
      },
      async (input): Promise<ToolResult> => {
        const name = typeof input?.name === 'string' ? input.name : '';
        if (!name) {
          return { summary: `${prefix}get_prompt`, text: 'get_prompt requires a "name".', isError: true };
        }
        const argsIn = input?.arguments;
        const args =
          argsIn && typeof argsIn === 'object' && !Array.isArray(argsIn)
            ? Object.fromEntries(
                Object.entries(argsIn as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
              )
            : undefined;
        try {
          const res = await getPrompt({ name, ...(args ? { arguments: args } : {}) });
          return promptToToolResult(`${prefix}get_prompt`, res);
        } catch (err) {
          return errorResult(`${prefix}get_prompt`, err);
        }
      },
    );
  }

  if (caps.resources && client.listResources && client.readResource) {
    const listResources = client.listResources.bind(client);
    const readResource = client.readResource.bind(client);
    add(
      'list_resources',
      `List the resources this MCP server exposes (uri, name, mime). Read-only.`,
      { type: 'object', properties: {} },
      async (): Promise<ToolResult> => {
        try {
          const { resources } = await listResources();
          const lines = (Array.isArray(resources) ? resources : []).map((r) => {
            const nm = r.title ?? r.name;
            const mime = r.mimeType ? ` [${r.mimeType}]` : '';
            return `• ${r.uri}${nm ? ` — ${nm}` : ''}${mime}`;
          });
          const text = lines.length > 0 ? lines.join('\n') : '(no resources)';
          return { summary: `${prefix}list_resources`, text: scrubAndClipCapabilityText(text) };
        } catch (err) {
          return errorResult(`${prefix}list_resources`, err);
        }
      },
    );
    add(
      'read_resource',
      `Read one of this server's resources by uri. Args: { uri }. Read-only.`,
      {
        type: 'object',
        properties: { uri: { type: 'string', description: 'The resource uri from list_resources.' } },
        required: ['uri'],
      },
      async (input): Promise<ToolResult> => {
        const uri = typeof input?.uri === 'string' ? input.uri : '';
        if (!uri) {
          return { summary: `${prefix}read_resource`, text: 'read_resource requires a "uri".', isError: true };
        }
        try {
          const res = await readResource({ uri });
          return resourceToToolResult(`${prefix}read_resource`, res);
        } catch (err) {
          return errorResult(`${prefix}read_resource`, err);
        }
      },
    );
  }

  return out;
}

/** Shared error→ToolResult mapping for the synthesized capability tools. */
function errorResult(name: string, err: unknown): ToolResult {
  return {
    summary: `${name} error`,
    text: externalErrorText(name, err),
    isError: true,
  };
}

function externalErrorText(name: string, err: unknown): string {
  return `${name} failed — ${scrubAndClipCapabilityText(toMessage(err))}`;
}

/** A fresh MCP `Client` with marudesk's identity (no special capabilities). */
function newClient(): Client {
  return new Client({ name: 'marudesk', version: '0.1.0' }, { capabilities: {} });
}

/**
 * Real connector factory — dispatches on transport. Overridable by the harness via
 * {@link connectServer} / {@link syncExternalMcpServers}. Stdio spawns a local
 * process; http/sse reach a remote endpoint.
 */
async function connectClient(config: McpServerConfig): Promise<{ client: McpClientLike }> {
  return isHttpMcpConfig(config) ? connectHttp(config) : connectStdio(config);
}

/** Spawn a local stdio MCP server and run the initialize handshake. */
async function connectStdio(config: McpServerConfig): Promise<{ client: McpClientLike }> {
  if (isHttpMcpConfig(config)) throw new Error('not a stdio config'); // unreachable; narrows the union
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    // Merge the inherited safe env with the user's overrides. Values may be
    // secret — they're never logged.
    env: { ...getInheritedEnv(), ...(config.env ?? {}) },
    // Pipe stderr so a spawn error surfaces in our log, not the user's console.
    stderr: 'pipe',
  });
  const client = newClient();
  // connect() spawns the process and runs the MCP initialize handshake; bound by a
  // connect timeout so a hung server can't wedge the manager.
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return { client: client as unknown as McpClientLike };
}

/**
 * Connect to a remote MCP server. For `transport: 'http'` we try Streamable HTTP
 * first (the current spec transport) and, on a connect failure, fall back to legacy
 * SSE — many older hosted servers still only speak SSE. For `transport: 'sse'` we go
 * straight to SSE. User headers (e.g. `Authorization`) ride on every request; their
 * values are secret and never logged.
 */
async function connectHttp(config: McpServerConfig): Promise<{ client: McpClientLike }> {
  if (!isHttpMcpConfig(config)) throw new Error('not an http config'); // unreachable; narrows the union
  const url = new URL(config.url);
  const requestInit = config.headers ? { headers: config.headers } : undefined;

  // For SSE the initial stream is a GET whose headers come from a custom fetch
  // (EventSourceInit can't carry headers); reuse it for the POST channel too so
  // auth headers apply uniformly.
  const headerFetch: typeof fetch | undefined = config.headers
    ? (input, init) =>
        fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...config.headers } })
    : undefined;

  const tryConnect = async (kind: 'http' | 'sse'): Promise<McpClientLike> => {
    const client = newClient();
    const transport =
      kind === 'http'
        ? new StreamableHTTPClientTransport(url, { requestInit })
        : new SSEClientTransport(url, { requestInit, ...(headerFetch ? { fetch: headerFetch } : {}) });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client as unknown as McpClientLike;
  };

  if (config.transport === 'sse') return { client: await tryConnect('sse') };
  try {
    return { client: await tryConnect('http') };
  } catch (err) {
    // Streamable HTTP failed — retry as SSE before giving up (graceful downgrade).
    console.warn(`[mcp] "${config.id}" Streamable HTTP failed, trying SSE fallback`);
    try {
      return { client: await tryConnect('sse') };
    } catch {
      // Surface the original (more informative) Streamable HTTP error.
      throw err;
    }
  }
}

/** A minimal safe env to inherit (avoid leaking the full parent env to children). */
function getInheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'TEMP', 'TMP', 'SystemRoot', 'PATHEXT']) {
    const v = process.env[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/**
 * Connect one server: spawn, initialize, list its tools, wrap them, and register.
 * The `connect` factory is injectable so the headless harness can exercise the
 * wrapping/registration against a mock client without spawning a real process.
 * Never throws — failure is logged + recorded as `error` status (graceful).
 */
export function connectServer(
  config: McpServerConfig,
  connect: ConnectFn = connectClient,
): Promise<McpServerStatus> {
  // Pending-connect dedup (MCP-1): two concurrent connect/sync calls for the same id
  // share ONE connection instead of racing (which would double-register and leak the
  // first client). The first caller drives the connect; the rest await its result.
  const inflight = pendingConnects.get(config.id);
  if (inflight) return inflight;
  const run = connectServerInner(config, connect).finally(() => {
    pendingConnects.delete(config.id);
  });
  pendingConnects.set(config.id, run);
  return run;
}

async function connectServerInner(
  config: McpServerConfig,
  connect: ConnectFn,
): Promise<McpServerStatus> {
  // A deliberate connect supersedes any pending backoff retry for this id.
  cancelReconnect(config.id);
  // Deferred exposure (MCP-1): if we've seen this server's tools before (a reconnect),
  // register them from cache RIGHT NOW so the model can call them with zero connect
  // latency. Each cached tool's exec waits for the real client (see buildDeferredServer)
  // — the fully-connected server replaces this entry once the connect settles below.
  const cachedTools = lastKnownTools.get(config.id);
  const hasDeferred = Array.isArray(cachedTools) && cachedTools.length > 0;
  if (hasDeferred) {
    registerMcpServer(buildDeferredServer(config.id, cachedTools, optsFromConfig(config)));
    deferredRegistered.add(config.id);
  }
  setStatus(config, 'connecting', 0);
  try {
    const { client } = await connect(config);
    let tools: McpExternalToolInfo[];
    try {
      const listed = await client.listTools();
      tools = Array.isArray(listed?.tools) ? listed.tools : [];
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    // Cache the fresh list for the next reconnect's deferred exposure.
    lastKnownTools.set(config.id, tools);
    const server = wrapExternalServer(config.id, client, tools, optsFromConfig(config));
    registerMcpServer(server);
    // The real connection now backs the tools — the deferred placeholder (if any) is replaced.
    deferredRegistered.delete(config.id);
    const status = setConnectedStatus(config, server);
    // Keep the connector on the live entry so an unexpected drop reconnects the same way.
    live.set(config.id, { config, client, status, connect });
    // Hand the live client to any deferred tool calls that were waiting on this reconnect.
    drainClientResolvers(config.id, client);
    // Crash detection: if the transport drops after we're connected, drop the dead
    // tools and schedule a backoff reconnect (§health) so a transient blip recovers.
    client.onclose = () => handleUnexpectedClose(config.id);
    // Live refresh: re-discover tools when the server announces a list change.
    subscribeListChanges(config.id, client);
    console.log(`[mcp] connected "${config.id}" — ${server.tools.length} tool(s)`);
    return status;
  } catch (err) {
    const message = toMessage(err || 'failed to connect');
    // Don't log the message verbatim (args/env/headers could be sensitive) — id + a
    // scrubbed reason is enough to debug.
    console.error(`[mcp] server "${config.id}" failed to connect: ${scrubAndClipToolMetadataText(message)}`);
    // If this attempt exposed deferred tools but failed to connect, drop them so the
    // model doesn't see tools backed by a never-resolving client. A subsequent backoff
    // retry re-exposes them. Waiters are left queued for the retry (the turn signal
    // still bounds them); a final give-up reaches beginReconnect's give-up branch.
    if (hasDeferred && !live.has(config.id)) {
      unregisterMcpServer(config.id);
      deferredRegistered.delete(config.id);
    }
    return setStatus(config, 'error', 0, { error: message });
  }
}

/** The wrapping options derived from a server's config (trust + tool filters). */
function optsFromConfig(config: McpServerConfig): ExternalServerOptions {
  const options: ExternalToolPolicyOptions = {
    trusted: config.trust === true,
    disabledTools: config.disabledTools,
    autoApproveTools: config.autoApproveTools,
    confirmTools: config.confirmTools,
  };
  return options;
}

/**
 * Build the full external {@link McpServer}: the wrapped real tools plus the
 * synthesized prompt/resource meta-tools (a real tool of the same name wins). Used by
 * both the initial connect and the live tool-list refresh.
 */
function wrapExternalServer(
  id: string,
  client: McpClientLike,
  tools: McpExternalToolInfo[],
  opts: ExternalServerOptions,
): McpServer {
  const base = buildExternalServer(id, client, tools, opts);
  const existing = new Set(base.tools.map((t) => t.name));
  const capabilityTools = buildCapabilityTools(id, client, opts, existing);
  return capabilityTools.length > 0
    ? { name: id, tools: [...base.tools, ...capabilityTools] }
    : base;
}

/** Record a connected status row for a (re)registered server. */
function setConnectedStatus(config: McpServerConfig, server: McpServer): McpServerStatus {
  const toolNames = server.tools.map((t) => t.name.slice(`${config.id}__`.length));
  return setStatus(config, 'connected', server.tools.length, { tools: toolNames });
}

/* ── live tool-list refresh (docs/context-mcp-design §9) ─────────────────────── */

/**
 * Subscribe to the server's list-changed notifications so the agent's tool set tracks
 * a server that adds/removes tools at runtime (the MCP spec's
 * `notifications/tools/list_changed`). Prompts/resources are read live through the
 * synthesized meta-tools, so their list-changed events need no re-registration — but
 * we still re-run discovery on them harmlessly to keep capability tools in sync. A
 * server/SDK without notification support (no `setNotificationHandler`) just skips
 * this — the initial tool set stays put.
 */
function subscribeListChanges(id: string, client: McpClientLike): void {
  if (!client.setNotificationHandler) return;
  const refresh = (): Promise<void> => refreshServerTools(id);
  for (const schema of [
    ToolListChangedNotificationSchema,
    PromptListChangedNotificationSchema,
    ResourceListChangedNotificationSchema,
  ]) {
    try {
      client.setNotificationHandler(schema, refresh);
    } catch {
      // Some transports/servers reject unknown handlers — ignore; live refresh is
      // a best-effort enhancement, never required for correctness.
    }
  }
}

/**
 * Re-list a connected server's tools and re-register them (responding to a
 * list-changed notification). No-op if the server isn't currently live (it may be
 * reconnecting or torn down). A failed re-list is logged and leaves the prior tools
 * in place rather than blanking them.
 */
async function refreshServerTools(id: string): Promise<void> {
  const entry = live.get(id);
  if (!entry) return;
  try {
    const listed = await entry.client.listTools();
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    // Keep the deferred cache fresh so a later reconnect exposes the current tools.
    lastKnownTools.set(id, tools);
    const server = wrapExternalServer(id, entry.client, tools, optsFromConfig(entry.config));
    registerMcpServer(server);
    entry.status = setConnectedStatus(entry.config, server);
    console.log(`[mcp] "${id}" tool list changed — now ${server.tools.length} tool(s)`);
  } catch (err) {
    const message = toMessage(err || 'failed to refresh tools');
    console.error(`[mcp] "${id}" tool refresh failed: ${scrubAndClipToolMetadataText(message)}`);
  }
}

/* ── auto-reconnect with exponential backoff (docs/context-mcp-design §8.3) ──── */

/** The connector factory shape — injectable so the harness can drive reconnects. */
type ConnectFn = (c: McpServerConfig) => Promise<{ client: McpClientLike }>;

/** Fast exponential-backoff retries right after a drop (transient blips). */
const MAX_RECONNECT_ATTEMPTS = 5;
/**
 * First retry delay; doubles each attempt, capped at {@link RECONNECT_CAP_MS}. The
 * backoff schedule is therefore [500, 1000, 2000, 4000, 8000…] (MCP-1) so a
 * transient blip recovers fast without a full second of dead air on the first retry.
 */
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 30_000;
/**
 * After the fast burst, keep trying on a slow fixed interval (circuit-breaker
 * recovery, v6 §W6) so a longer outage — a server restart, VPN drop, laptop
 * sleep — heals on its own instead of staying dead until a manual Reload.
 */
const IDLE_RETRY_MS = 60_000;
const MAX_IDLE_RETRIES = 10;
const MAX_TOTAL_ATTEMPTS = MAX_RECONNECT_ATTEMPTS + MAX_IDLE_RETRIES;

/** Pending reconnect timers, keyed by config id (with the data to retry). */
type ReconnectEntry = { handle: unknown; config: McpServerConfig; connect: ConnectFn; attempt: number };
const reconnects = new Map<string, ReconnectEntry>();

// Injectable scheduler so the headless harness drives reconnects deterministically
// instead of waiting real wall-clock backoff. Production uses setTimeout/clearTimeout.
let scheduleReconnect: (run: () => Promise<void>, ms: number) => unknown = (run, ms) =>
  setTimeout(() => void run(), ms);
let cancelScheduled: (handle: unknown) => void = (handle) =>
  clearTimeout(handle as ReturnType<typeof setTimeout>);

/**
 * Override the reconnect scheduler (harness only). Pass a `schedule` that captures the
 * runner (so the test can flush it) and an optional matching `cancel`; pass `null` to
 * restore the real `setTimeout`-based scheduler.
 */
export function setReconnectSchedulerForTests(
  schedule: ((run: () => Promise<void>, ms: number) => unknown) | null,
  cancel?: (handle: unknown) => void,
): void {
  if (schedule) {
    scheduleReconnect = schedule;
    cancelScheduled = cancel ?? (() => {});
  } else {
    scheduleReconnect = (run, ms) => setTimeout(() => void run(), ms);
    cancelScheduled = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

/** Exponential backoff for attempt N (1-based), capped. */
function backoffMs(attempt: number): number {
  return Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
}

/** Cancel and forget any pending reconnect timer for an id. */
function cancelReconnect(id: string): void {
  const entry = reconnects.get(id);
  if (!entry) return;
  cancelScheduled(entry.handle);
  reconnects.delete(id);
}

/**
 * Schedule reconnect attempt N. Attempts 1..{@link MAX_RECONNECT_ATTEMPTS} use fast
 * exponential backoff; after that we don't give up immediately but fall back to a
 * slow fixed-interval "idle" retry (v6 §W6) so a longer outage can still recover on
 * its own. Only after {@link MAX_TOTAL_ATTEMPTS} do we mark `error` (the UI shows
 * it failed and the user can Reload).
 */
function beginReconnect(config: McpServerConfig, connect: ConnectFn, attempt: number): void {
  if (attempt > MAX_TOTAL_ATTEMPTS) {
    console.error(`[mcp] server "${config.id}" gave up reconnecting after ${MAX_TOTAL_ATTEMPTS} attempts`);
    setStatus(config, 'error', 0, { error: 'connection closed' });
    // The server is now considered dead — fail any deferred tool calls still waiting
    // for it, drop its cache, and remove any deferred placeholder tools so a future
    // deliberate connect starts clean (MCP-1).
    lastKnownTools.delete(config.id);
    rejectClientResolvers(config.id, 'MCP server unavailable (reconnect gave up)');
    if (deferredRegistered.delete(config.id) && !live.has(config.id)) unregisterMcpServer(config.id);
    return;
  }
  const idle = attempt > MAX_RECONNECT_ATTEMPTS;
  const delay = idle ? IDLE_RETRY_MS : backoffMs(attempt);
  setStatus(config, 'reconnecting', 0, {
    error: idle
      ? `reconnecting (periodic retry ${attempt - MAX_RECONNECT_ATTEMPTS}/${MAX_IDLE_RETRIES})`
      : `reconnecting (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`,
  });
  const handle = scheduleReconnect(() => runReconnect(config, connect, attempt), delay);
  reconnects.set(config.id, { handle, config, connect, attempt });
}

/** Fire one reconnect attempt; on failure, schedule the next with a longer backoff. */
async function runReconnect(config: McpServerConfig, connect: ConnectFn, attempt: number): Promise<void> {
  // A deliberate teardown / config change between scheduling and firing cancels us.
  if (!reconnects.has(config.id)) return;
  reconnects.delete(config.id);
  const status = await connectServer(config, connect);
  if (status.state !== 'connected') beginReconnect(config, connect, attempt + 1);
}

/**
 * Handle a live server's transport closing unexpectedly (process exit, network
 * loss). We unregister its tools so the agent can't call into a dead connection, then
 * schedule a backoff reconnect over the same connector. A deliberate teardown
 * (disconnectServer) clears the `onclose` first, so this only fires on real drops.
 */
function handleUnexpectedClose(id: string): void {
  const entry = live.get(id);
  if (!entry) return;
  live.delete(id);
  unregisterMcpServer(id);
  console.error(`[mcp] server "${id}" connection closed unexpectedly — scheduling reconnect`);
  beginReconnect(entry.config, entry.connect, 1);
}

/** Disconnect one server: cancel any reconnect, unregister its tools + close it. */
async function disconnectServer(id: string): Promise<void> {
  // Cancel a pending reconnect first (a reconnecting server isn't in `live`).
  cancelReconnect(id);
  // Deliberate teardown (MCP-1): drop the deferred cache and fail any waiting deferred
  // tool calls so they don't hang on a client that will never come back.
  lastKnownTools.delete(id);
  rejectClientResolvers(id, 'MCP server disconnected');
  // A deferred placeholder may be registered for a server that's mid-reconnect (not in
  // `live`) — unregister it here so a deliberate removal/disable clears its tools too.
  if (deferredRegistered.delete(id) && !live.has(id)) unregisterMcpServer(id);
  const entry = live.get(id);
  if (!entry) return;
  live.delete(id);
  unregisterMcpServer(id);
  deferredRegistered.delete(id);
  // Detach the crash handler first — this is a deliberate teardown, not a drop.
  entry.client.onclose = undefined;
  await entry.client.close().catch(() => {});
}

/**
 * Reconcile the live connections with a config list: disconnect servers that were
 * removed or disabled or whose command/args/env changed, then connect any enabled
 * server that isn't already live. Disabled/removed servers keep a status row so the
 * UI still lists them. Called at startup and whenever the config changes.
 *
 * The `connect` factory is injectable for the harness; production passes the real
 * transport-dispatching connector.
 */
export async function syncExternalMcpServers(
  configs: McpServerConfig[],
  connect?: (c: McpServerConfig) => Promise<{ client: McpClientLike }>,
): Promise<McpServerStatus[]> {
  const byId = new Map(configs.map((c) => [c.id, c] as const));

  // Drop status rows for ids no longer in the config at all.
  for (const id of [...statuses.keys()]) {
    if (!byId.has(id)) statuses.delete(id);
  }

  // Disconnect anything that should no longer be live (removed / disabled / changed).
  for (const id of [...live.keys()]) {
    const next = byId.get(id);
    if (!next || !next.enabled || configChanged(live.get(id)!.config, next)) {
      await disconnectServer(id);
    }
  }

  // Cancel pending backoff reconnects for servers now removed / disabled / changed —
  // a reconnecting server isn't in `live`, so the loop above wouldn't catch it.
  for (const id of [...reconnects.keys()]) {
    const next = byId.get(id);
    if (!next || !next.enabled || configChanged(reconnects.get(id)!.config, next)) {
      cancelReconnect(id);
    }
  }

  // Record disabled servers (so they appear in the UI) and connect enabled ones
  // that aren't already live (and aren't mid-reconnect, which we leave to back off).
  for (const config of configs) {
    if (!config.enabled) {
      if (!live.has(config.id)) setStatus(config, 'disabled', 0);
      continue;
    }
    if (live.has(config.id) || reconnects.has(config.id)) continue;
    // Connect sequentially — a slow/hung server is bounded by CONNECT_TIMEOUT_MS,
    // and configs are few. Each call is graceful (never throws).
    await connectServer(config, connect ?? connectClient);
  }

  return listMcpServerStatuses();
}

/**
 * Whether a server's connection-affecting fields changed (forces a reconnect).
 * Covers the transport, its endpoint/secrets, and the wrapping options (trust /
 * disabledTools / autoApproveTools) — the latter change the tool set or its gating
 * the agent sees, so a reconnect re-wraps them.
 */
function configChanged(a: McpServerConfig, b: McpServerConfig): boolean {
  if (mcpTransportOf(a) !== mcpTransportOf(b)) return true;
  if (a.trust !== b.trust) return true;
  if (JSON.stringify(a.disabledTools ?? []) !== JSON.stringify(b.disabledTools ?? [])) return true;
  if (JSON.stringify(a.autoApproveTools ?? []) !== JSON.stringify(b.autoApproveTools ?? [])) return true;
  if (JSON.stringify(a.confirmTools ?? []) !== JSON.stringify(b.confirmTools ?? [])) return true;
  if (isHttpMcpConfig(a) && isHttpMcpConfig(b)) {
    return (
      a.url !== b.url ||
      JSON.stringify(a.headers ?? {}) !== JSON.stringify(b.headers ?? {})
    );
  }
  if (!isHttpMcpConfig(a) && !isHttpMcpConfig(b)) {
    return (
      a.command !== b.command ||
      JSON.stringify(a.args ?? []) !== JSON.stringify(b.args ?? []) ||
      JSON.stringify(a.env ?? {}) !== JSON.stringify(b.env ?? {})
    );
  }
  return true; // transport kind differs in a way the guards above didn't catch
}

/** Current status of every configured server (connected, disabled, or errored). */
export function listMcpServerStatuses(): McpServerStatus[] {
  return [...statuses.values()];
}

/** Tear down every live connection (called on app quit). */
export async function disposeExternalMcpServers(): Promise<void> {
  // Cancel any pending reconnect timers (including for non-live, reconnecting ones).
  for (const id of [...reconnects.keys()]) cancelReconnect(id);
  const ids = [...live.keys()];
  await Promise.all(ids.map((id) => disconnectServer(id)));
  // Unregister any deferred placeholder still registered for a server that never reached
  // `live` (a stalled reconnect) — disconnectServer above only iterates live ids.
  for (const id of [...deferredRegistered]) unregisterMcpServer(id);
  deferredRegistered.clear();
  // Fail any deferred tool calls still waiting on a server that never became live (a
  // reconnecting one disconnectServer didn't cover), and drop all deferred state so
  // nothing dangles past app exit (MCP-1 before-quit teardown).
  for (const id of [...clientResolvers.keys()]) {
    rejectClientResolvers(id, 'app shutting down');
  }
  lastKnownTools.clear();
  pendingConnects.clear();
  statuses.clear();
}
