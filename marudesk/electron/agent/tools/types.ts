import type { WorkspaceSummary } from '../../../shared/workspace';
import type { AppliedChange } from '../../../shared/patch';

/**
 * Shared shapes for the agent tool layer (docs/agentic-chat-design.md §4). The
 * executors (executors.ts), the JSON-Schema list (schemas.ts), and the MCP
 * descriptor layer (registry.ts) all depend on these and nothing else, so this
 * module stays free of Electron/runtime imports.
 */

export type ToolSchema = {
  name: string;
  description: string;
  /** JSON Schema for the tool input (Anthropic `input_schema`). */
  inputSchema: object;
};

export type ToolContext = {
  /**
   * The open workspace, or null when the user is chatting without a folder open.
   * File tools (read/list/grep/edit) are then unavailable and return a friendly
   * error; the browser/page tools (console/dom/network/eval) work regardless.
   */
  ws: WorkspaceSummary | null;
  /** The active web tab id — runtime tools (console/dom/network) target it. */
  tabId?: string;
  /** Aborts an in-flight tool (e.g. the wait inside reload_and_verify). */
  signal: AbortSignal;
  /**
   * Path globs the agent may never edit (Settings → Agent, Track B §B4). Checked
   * in applyEdits against each edit's workspace-relative path. Undefined/empty =
   * no extra deny rules (the read-side SECRET_FILE guard still applies).
   */
  denyGlobs?: string[];
};

export type ToolResult = {
  /** One-line card header, e.g. "edit src/App.tsx". */
  summary: string;
  /** tool_result content for the model — already scrubbed + clipped. */
  text: string;
  isError?: boolean;
  /** File edits applied by this call, for the chat's diff/revert history (P2). */
  edits?: AppliedChange[];
};

export type Executor = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

/**
 * Tools that require explicit user approval per call: code execution (eval_js)
 * and the sensitive read-only context tools (cookies / web storage often hold
 * session tokens). This is the interim of Track B §B4's `ask` default until the
 * full glob-permission / approval-mode system lands.
 */
export const GATED_TOOLS = new Set([
  'eval_js',
  'click',
  'fill',
  'press_key',
  'scroll',
  'browser_cookies',
  'browser_storage',
]);

/** `ask_user` is intercepted by the loop (it parks the turn), never executed here. */
export const ASK_USER = 'ask_user';

/* ── MCP descriptor layer (docs/context-mcp-design §1.1) ─────────────────── */

/**
 * A tool's source group — used to organize the built-in "marudesk" context MCP
 * server and (later) to scope glob permissions. Browser/devtools/terminal/tabs
 * read the LIVE running app over CDP / main state; files reads the workspace;
 * sessions/memory read the new persistent stores; `ask` is the loop-intercepted
 * ask_user.
 */
export type McpGroup =
  | 'files'
  | 'browser'
  | 'devtools'
  | 'terminal'
  | 'tabs'
  | 'sessions'
  | 'memory'
  | 'skills'
  | 'pc'
  // Tools from an external (stdio) MCP connector — third-party, so `gated` by
  // default (see electron/agent/mcp-external.ts).
  | 'mcp'
  | 'ask';

/** A self-describing tool definition (JSON-Schema + the metadata the loop needs). */
export type McpToolDef = ToolSchema & {
  group: McpGroup;
  /** Requires explicit per-call user approval (e.g. eval_js, cookies/storage). */
  gated?: boolean;
  /** Mutates the workspace/app state — refused outright in read-only mode. */
  write?: boolean;
  /** Needs a live web tab as its target. */
  requiresWeb?: boolean;
  /** Needs an open workspace folder. */
  requiresWorkspace?: boolean;
};

/** A tool definition plus its in-process executor — what a built-in server holds. */
export type McpTool = McpToolDef & { exec: Executor };
